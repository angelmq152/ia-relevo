import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RelevoLimits, RelevoRun } from '../types'
import { agyUsage, codexUsage, formatSummary, metaValue, summarize } from './savings'
import type { RunTally } from './savings'
import { limitMetrics, quotaHits, runLog, runMetrics } from './telemetry'

const POLL_MS = 5000

// OTLP/HTTP base URL from the otlpEndpoint option; empty sends nothing.
let otlpEndpoint = ''

const runs = atom({ plugin: 'ia-relevo', key: 'runs' } as const, [] as RelevoRun[])
const limits = atom({ plugin: 'ia-relevo', key: 'limits' } as const, {} as RelevoLimits)

const DELEGATE_DESCRIPTION = `Delegates a closed coding task to an external agent (Codex CLI or Antigravity agy) so it spends that agent's quota instead of Claude's. It starts in the background and returns at once; a message with the agent's final report arrives when it finishes, so do not poll or wait on it.

Pick the kind and level yourself, the model comes from the table:
- kind: back (logic, tests, scripts, debugging), front (HTML/CSS/JS UI, motion), read (analysing a lot of code, use with sandbox read-only), mech (repetitive edits with no judgement).
- level: facil (small and obvious), normal (the default), dificil (design calls, tricky bugs, visual work that must look right).
Write the prompt as a complete brief: the agent has no access to this conversation. Give each parallel task a disjoint write_lot. The agent never commits; review its changes and commit yourself.`

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'

const script = ($: EngineInterface) => `${$.plugin.root}/bin/relevo.sh`

const readOr = async ($: EngineInterface, path: string, fallback = '') => {
  try {
    return await $.fs.read(path)
  } catch {
    return fallback
  }
}

const sendOtlp = async ($: EngineInterface, signal: 'metrics' | 'logs', payload: unknown) => {
  if (!otlpEndpoint) return
  try {
    const sent = await $.http.fetch(`${otlpEndpoint}/v1/${signal}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!sent.ok) $.ui.log(`ia-relevo: OTLP ${signal} answered ${sent.status}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`ia-relevo: OTLP ${signal} failed: ${String(err)}`, { to: 'debug' })
  }
}

const reportRun = async ($: EngineInterface, run: RelevoRun, meta: string, exit: string) => {
  if (!otlpEndpoint) return
  const tally = await tallyRun($, run.dir)
  const started = Date.parse(metaValue(meta, 'started'))
  const ended = await $.fs.stat(`${run.dir}/exit`).then(s => s.mtimeMs, () => Date.now())
  const now = await $.clock.now()
  const event = {
    name: run.name,
    engine: tally?.engine ?? 'none',
    model: tally?.model ?? 'none',
    kind: run.kind,
    level: run.level,
    isOk: exit.trim() === '0',
    durationSeconds: Number.isFinite(started) ? Math.max(0, (ended - started) / 1000) : 0,
    usage: tally?.usage ?? { fresh: 0, cached: 0, output: 0 },
    quotaHits: quotaHits(await readOr($, `${run.dir}/stderr.log`)),
  }
  await sendOtlp($, 'metrics', runMetrics(event, now))
  await sendOtlp($, 'logs', runLog(event, now))
}

const refreshStatus = async ($: EngineInterface) => {
  const running = (await read($, runs)).filter(r => !r.isDone).length
  const l = await read($, limits)
  const parts = [
    running > 0 ? `relevo: ${running} en curso` : undefined,
    l.fiveHour !== undefined ? `5h ${l.fiveHour}%` : undefined,
    l.weekly !== undefined ? `semana ${l.weekly}%` : undefined,
  ].filter(Boolean)
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

const finishRun = async ($: EngineInterface, run: RelevoRun) => {
  const [exit, meta, report] = await Promise.all([
    readOr($, `${run.dir}/exit`, '?'),
    readOr($, `${run.dir}/meta`),
    readOr($, `${run.dir}/last.md`),
  ])
  const engine = metaValue(meta, 'engine') || '?'
  const model = metaValue(meta, 'model') || '?'
  const body = report.trim() || (await readOr($, `${run.dir}/stderr.log`)).trim().split('\n').slice(-15).join('\n')
  $.ui.toast(`ia-relevo: «${run.name}» terminado con ${engine}`)
  void reportRun($, run, meta, exit)
  void $.prompt.submit({
    text: [
      `[ia-relevo] The delegated task "${run.name}" finished: engine ${engine}, model ${model}, exit ${exit.trim()}.`,
      `Run dir: ${run.dir}`,
      '',
      body || '(no report)',
      '',
      'Review the changes it made before committing.',
    ].join('\n'),
  })
}

const poll = async ($: EngineInterface) => {
  const pending = (await read($, runs)).filter(r => !r.isDone)
  for (const run of pending) {
    if (!(await $.fs.exists(`${run.dir}/exit`))) continue
    await update($, runs, list => list.map(r => (r.dir === run.dir ? { ...r, isDone: true } : r)))
    await finishRun($, run)
  }
  if (pending.length > 0) await refreshStatus($)
}

const tallyRun = async ($: EngineInterface, dir: string): Promise<RunTally | undefined> => {
  const meta = await readOr($, `${dir}/meta`)
  const engine = metaValue(meta, 'engine')
  if (!engine) return undefined
  const model = metaValue(meta, 'model') || 'default'
  if (engine === 'codex') return { engine, model, usage: codexUsage(await readOr($, `${dir}/events.jsonl`)) }
  const docs = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^agy-.*\.json$/.test(f.name))
  const usages = await Promise.all(docs.map(async f => agyUsage(await readOr($, `${dir}/${f.name}`))))
  const usage = usages.reduce(
    (a, b) => ({ fresh: a.fresh + b.fresh, cached: a.cached + b.cached, output: a.output + b.output }),
    { fresh: 0, cached: 0, output: 0 },
  )
  return { engine, model, usage }
}

const savingsReport = async ($: EngineInterface, days: number) => {
  const root = (await $.process.run(['bash', script($), 'runs'])).stdout.trim()
  const since = new Date((await $.clock.now()) - days * 86_400_000)
  const stamp = since.toISOString().slice(0, 10).replaceAll('-', '')
  const dirs = (await $.fs.list(root))
    .filter(f => f.kind === 'dir' && /^\d{8}-\d{6}-/.test(f.name) && f.name.slice(0, 8) >= stamp)
    .map(f => `${root}/${f.name}`)
  const tallies = (await Promise.all(dirs.map(d => tallyRun($, d)))).filter((t): t is RunTally => t !== undefined)
  return formatSummary(summarize(tallies), since.toISOString().slice(0, 10))
}

export const register: Register = (on, options) => {
  otlpEndpoint = typeof options.otlpEndpoint === 'string' ? options.otlpEndpoint.replace(/\/+$/, '') : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'delegar',
      description: DELEGATE_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short task name, used for the run folder.' },
          prompt: { type: 'string', description: 'The complete brief for the agent.' },
          kind: { type: 'string', enum: ['back', 'front', 'read', 'mech'] },
          level: { type: 'string', enum: ['facil', 'normal', 'dificil'] },
          cwd: { type: 'string', description: 'Absolute working directory; the session one when left out.' },
          write_lot: { type: 'string', description: 'Files or folders the agent may write, the only ones.' },
          read_only: { type: 'string', description: 'Files or folders it may read but not touch.' },
          sandbox: { type: 'string', enum: ['workspace-write', 'read-only', 'full'] },
          network: { type: 'boolean' },
          add_dirs: { type: 'array', items: { type: 'string' } },
          engine: { type: 'string', enum: ['codex', 'agy'], description: 'Forces one engine; needed for model.' },
          model: { type: 'string', description: 'Overrides the table, only with engine.' },
          effort: { type: 'string', description: 'Codex reasoning effort override, only with engine.' },
        },
        required: ['name', 'prompt', 'kind', 'level'],
      },
    })
    await $.tool.register({
      name: 'seguir',
      description:
        'Sends a follow-up message to a finished delegated task, in the same agent conversation, in the background. Use it to ask for a fix after reviewing its report; the new report arrives as a message.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          run: { type: 'string', description: 'The run dir from the task report.' },
          message: { type: 'string' },
        },
        required: ['run', 'message'],
      },
    })
    await $.command.register({ name: 'relevo', description: 'Encargos delegados de esta sesión y estado de los motores' })
    await $.command.register({
      name: 'relevo-ahorro',
      description: 'Tokens equivalentes de Claude que han hecho Codex y agy (por defecto, últimos 7 días)',
    })
    $.clock.every(POLL_MS, () => void poll($))
    await refreshStatus($)
    return started
  })

  on('tool.call', { tool: 'mcp__ia-relevo__delegar' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const str = (k: string) => (typeof input[k] === 'string' && input[k] !== '' ? (input[k] as string) : undefined)
    const name = slug(str('name') ?? 'task')
    const kind = str('kind') ?? 'back'
    const level = str('level') ?? 'normal'
    const argv = ['bash', script($), 'start', '-n', name, '-C', str('cwd') ?? '.', '-k', kind, '-l', level]
    const flag = (opt: string, key: string) => {
      const v = str(key)
      if (v) argv.push(opt, v)
    }
    flag('-E', 'engine')
    flag('-m', 'model')
    flag('-e', 'effort')
    flag('-w', 'write_lot')
    flag('-r', 'read_only')
    if (str('sandbox') === 'read-only') argv.push('--ro')
    if (str('sandbox') === 'full') argv.push('--full')
    if (input.network === true) argv.push('--net')
    for (const d of Array.isArray(input.add_dirs) ? input.add_dirs : []) if (typeof d === 'string') argv.push('--add-dir', d)

    const started = await $.process.run(argv, { stdin: str('prompt') ?? '' })
    const dir = started.stdout.trim().split('\n').pop() ?? ''
    if (started.exitCode !== 0 || !dir) {
      return { result: `ia-relevo could not start the task: ${(started.stderr || started.stdout).trim()}`, isError: true }
    }
    const plan = (await readOr($, `${dir}/plan`)).trim().split('\n').join(', then ')
    await update($, runs, list => [
      ...list,
      { dir, name, kind, level, startedAt: Date.now(), isDone: false },
    ])
    await refreshStatus($)
    return {
      result: `Started "${name}" in the background (${kind}/${level}: ${plan}). Run dir: ${dir}. Its report arrives as a message when it finishes; do not poll.`,
    }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: delegar failed before starting the task.` }))

  on('tool.call', { tool: 'mcp__ia-relevo__seguir' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const run = typeof input.run === 'string' ? input.run : ''
    const message = typeof input.message === 'string' ? input.message : ''
    const sent = await $.process.run(['bash', script($), 'resume', run, message])
    const dir = sent.stdout.trim().split('\n').pop() ?? ''
    if (sent.exitCode !== 0 || !dir) {
      return { result: `ia-relevo could not resume: ${(sent.stderr || sent.stdout).trim()}`, isError: true }
    }
    const name = dir.split('/').pop()?.replace(/^\d{8}-\d{6}-/, '') ?? 'task'
    await update($, runs, list => [
      ...list.filter(r => r.dir !== dir),
      { dir, name, kind: 'resume', level: '-', startedAt: Date.now(), isDone: false },
    ])
    await refreshStatus($)
    return { result: `Follow-up sent to "${name}" in the background. Its report arrives as a message.` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: seguir failed before sending the message.` }))

  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(r => r.kind === 'five_hour')
    const week = e.rateLimits.find(r => r.kind === 'seven_day')
    if (five || week) {
      await update($, limits, () => ({ fiveHour: five?.percentUsed, weekly: week?.percentUsed }))
      await refreshStatus($)
    }
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      const windows = e.rateLimits.map(r => ({ window: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
      void sendOtlp($, 'metrics', limitMetrics(windows, await $.clock.now()))
    }
    return next(e)
  })

  on('command.run', { command: 'relevo' }, async $ => {
    const mine = await read($, runs)
    const engines = (await $.process.run(['bash', script($), 'status'])).stdout.trim()
    const lines = mine.length === 0
      ? ['Ningún encargo delegado en esta sesión.']
      : mine.map(r => `${r.isDone ? 'hecho   ' : 'en curso'}  ${r.name} (${r.kind}/${r.level})  ${r.dir}`)
    return { text: [...lines, '', engines].join('\n') }
  })

  on('command.run', { command: 'relevo-ahorro' }, async ($, e) => {
    const days = Number.parseInt(String(e.args ?? '').trim(), 10)
    return { text: await savingsReport($, Number.isFinite(days) && days > 0 ? days : 7) }
  })
}
