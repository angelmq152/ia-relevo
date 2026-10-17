import { expect, test } from 'claude-code/testing'

import { agyUsage, claudeEquivalent, codexUsage, formatSummary, metaValue, summarize } from '../hooks/savings'
import { limitMetrics, quotaHits, runLog, runMetrics } from '../hooks/telemetry'

test('codex usage sums every turn and splits cached input', () => {
  const events = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":10,"reasoning_output_tokens":2}}',
    'not json "usage"',
    '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":500,"output_tokens":5}}',
  ].join('\n')
  expect(codexUsage(events)).toEqual({ fresh: 200, cached: 1300, output: 17 })
})

test('agy usage counts thinking as output and survives bad json', () => {
  expect(agyUsage('{"usage":{"input_tokens":100,"output_tokens":5,"thinking_tokens":1,"cache_read_tokens":50}}'))
    .toEqual({ fresh: 100, cached: 50, output: 6 })
  expect(agyUsage('{oops')).toEqual({ fresh: 0, cached: 0, output: 0 })
})

test('claude equivalent uses the price ratios', () => {
  expect(claudeEquivalent({ fresh: 1000, cached: 10_000, output: 100 })).toBe(1250 + 1000 + 500)
})

test('summary groups by engine and model', () => {
  const s = summarize([
    { engine: 'agy', model: 'opus', usage: { fresh: 0, cached: 0, output: 200_000 } },
    { engine: 'agy', model: 'flash', usage: { fresh: 0, cached: 0, output: 200_000 } },
    { engine: 'codex', model: 'gpt', usage: { fresh: 0, cached: 0, output: 100_000 } },
  ])
  expect(s.runs).toBe(3)
  expect(s.byEngine.agy).toEqual({ runs: 2, equivalent: 2_000_000 })
  expect(s.byModel['codex gpt']).toEqual({ runs: 1, equivalent: 500_000 })
  expect(formatSummary(s, '2026-10-10')).toContain('3 encargos desde 2026-10-10, unos 2.50M')
  expect(formatSummary(summarize([]), 'x')).toContain('no hay encargos')
})

test('meta keeps the last value of a key', () => {
  expect(metaValue('engine=codex\nmodel=a\nengine=agy\nmodel=b\n', 'engine')).toBe('agy')
  expect(metaValue('name=x', 'model')).toBe('')
})

test('delegar starts the script with the table options and the brief on stdin', async ($, on) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  on('process.run', ($, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    return {
      value: { exitCode: 0, stdout: '/runs/20261017-120000-arreglar-login\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: 'codex gpt-reserve high\nagy claude-sonnet-5-5-medium -\n' }))

  const ran = await $.tool.call({
    tool: 'mcp__ia-relevo__delegar',
    name: 'Arreglar login',
    prompt: 'Fix the login bug',
    kind: 'back',
    level: 'normal',
    cwd: '/repo',
    write_lot: 'src/auth',
    sandbox: 'read-only',
  } as never)

  const start = calls.find(c => c.argv.includes('start'))
  expect(start?.argv.slice(2)).toEqual([
    'start', '-n', 'arreglar-login', '-C', '/repo', '-k', 'back', '-l', 'normal', '-w', 'src/auth', '--ro',
  ])
  expect(start?.stdin).toBe('Fix the login bug')
  expect(String(ran.result)).toContain('Run dir: /runs/20261017-120000-arreglar-login')
})

const run = {
  name: 'login',
  engine: 'agy',
  model: 'claude-opus-5-5-high',
  kind: 'back',
  level: 'dificil',
  isOk: true,
  durationSeconds: 42,
  usage: { fresh: 1000, cached: 10_000, output: 100 },
  quotaHits: ['codex'],
}

test('run metrics carry engine, model and status as delta sums', () => {
  const metrics = runMetrics(run, 1_700_000_000_000).resourceMetrics[0]!.scopeMetrics[0]!.metrics
  const byName = Object.fromEntries(metrics.map(m => [m.name, m]))
  const runs = byName['relevo.runs'] as { sum: { aggregationTemporality: number; dataPoints: { attributes: { key: string; value: { stringValue: string } }[]; asDouble: number }[] } }
  expect(runs.sum.aggregationTemporality).toBe(1)
  const labels = Object.fromEntries(runs.sum.dataPoints[0]!.attributes.map(a => [a.key, a.value.stringValue]))
  expect(labels).toEqual({ engine: 'agy', model: 'claude-opus-5-5-high', kind: 'back', level: 'dificil', status: 'ok', relayed: 'true' })
  expect((byName['relevo.claude_equivalent'] as { sum: { dataPoints: { asDouble: number }[] } }).sum.dataPoints[0]!.asDouble).toBe(2750)
  expect(Object.keys(byName)).toContain('relevo.quota_hits')
})

test('limit metrics keep the window and its reset time', () => {
  const metrics = limitMetrics([{ window: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-18T01:40:00Z' }], 0)
    .resourceMetrics[0]!.scopeMetrics[0]!.metrics
  expect(metrics.map(m => m.name)).toEqual(['relevo.plan.limit', 'relevo.plan.limit.resets_at'])
  expect((metrics[1] as { gauge: { dataPoints: { asDouble: number }[] } }).gauge.dataPoints[0]!.asDouble).toBe(Date.parse('2026-10-18T01:40:00Z') / 1000)
})

test('quota hits come from the stderr log', () => {
  expect(quotaHits('x\nrelevo: codex out of quota or not logged in (exit=1)\nrelevo: agy out of quota\n')).toEqual(['codex', 'agy'])
  expect(runLog(run, 0).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.body.stringValue).toBe('login: agy claude-opus-5-5-high ok in 42s')
})
