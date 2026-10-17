import { expect, test } from 'claude-code/testing'

import { agyUsage, claudeEquivalent, codexUsage, formatSummary, metaValue, summarize } from '../hooks/savings'

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
