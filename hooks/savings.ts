// Token accounting for the runs: what each external agent spent, converted to
// Claude-equivalent tokens with the API price ratios (fresh input written to the
// cache 1.25, cache read 0.1, output 5). An estimate, not what the plan meters.

export type Usage = { fresh: number; cached: number; output: number }

const ZERO: Usage = { fresh: 0, cached: 0, output: 0 }

const add = (a: Usage, b: Usage): Usage => ({
  fresh: a.fresh + b.fresh,
  cached: a.cached + b.cached,
  output: a.output + b.output,
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Codex `exec --json` writes one usage object per finished turn.
export const codexUsage = (events: string): Usage => {
  let total = ZERO
  for (const line of events.split('\n')) {
    if (!line.includes('"usage"')) continue
    let u: Record<string, unknown> | undefined
    try {
      const row = JSON.parse(line)
      u = row.usage ?? row.msg?.usage
    } catch {
      continue
    }
    if (!u || !('cached_input_tokens' in u)) continue
    const cached = num(u.cached_input_tokens)
    total = add(total, {
      fresh: Math.max(0, num(u.input_tokens) - cached),
      cached,
      output: num(u.output_tokens) + num(u.reasoning_output_tokens),
    })
  }
  return total
}

// agy `--output-format json` writes one document per call.
export const agyUsage = (doc: string): Usage => {
  try {
    const u = JSON.parse(doc).usage ?? {}
    return {
      fresh: num(u.input_tokens),
      cached: num(u.cache_read_tokens),
      output: num(u.output_tokens) + num(u.thinking_tokens),
    }
  } catch {
    return ZERO
  }
}

export const claudeEquivalent = (u: Usage): number =>
  Math.round(1.25 * u.fresh + 0.1 * u.cached + 5 * u.output)

export type RunTally = { engine: string; model: string; usage: Usage }

export type Summary = {
  runs: number
  byEngine: Record<string, { runs: number; equivalent: number }>
  byModel: Record<string, { runs: number; equivalent: number }>
  equivalent: number
}

export const summarize = (tallies: readonly RunTally[]): Summary => {
  const s: Summary = { runs: 0, byEngine: {}, byModel: {}, equivalent: 0 }
  for (const t of tallies) {
    const eq = claudeEquivalent(t.usage)
    s.runs += 1
    s.equivalent += eq
    for (const [map, key] of [[s.byEngine, t.engine], [s.byModel, `${t.engine} ${t.model}`]] as const) {
      const row = (map[key] ??= { runs: 0, equivalent: 0 })
      row.runs += 1
      row.equivalent += eq
    }
  }
  return s
}

export const millions = (n: number): string => `${(n / 1e6).toFixed(2)}M`

export const formatSummary = (s: Summary, since: string): string => {
  if (s.runs === 0) return `ia-relevo: no hay encargos terminados desde ${since}.`
  const rows = (map: Summary['byEngine']) =>
    Object.entries(map)
      .sort((a, b) => b[1].equivalent - a[1].equivalent)
      .map(([k, v]) => `  ${k.padEnd(34)} ${String(v.runs).padStart(3)} encargos  ${millions(v.equivalent)}`)
  return [
    `ia-relevo: ${s.runs} encargos desde ${since}, unos ${millions(s.equivalent)} tokens equivalentes de Claude fuera de tu cuota.`,
    '',
    'Por motor:',
    ...rows(s.byEngine),
    '',
    'Por modelo:',
    ...rows(s.byModel),
    '',
    'Estimación con los precios relativos de la API (entrada 1,25 · caché 0,1 · salida 5); el plan no mide exactamente así.',
  ].join('\n')
}

export const metaValue = (meta: string, key: string): string => {
  let value = ''
  for (const line of meta.split('\n')) if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1)
  return value
}
