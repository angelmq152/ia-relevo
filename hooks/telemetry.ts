// OTLP/HTTP JSON payloads for the run and plan metrics, sent to the collector
// named in the otlpEndpoint option. Sums are deltas (one finished run each);
// the collector's deltatocumulative processor turns them into counters.

import type { Usage } from './savings'
import { claudeEquivalent } from './savings'

export type RunEvent = {
  name: string
  engine: string
  model: string
  kind: string
  level: string
  isOk: boolean
  durationSeconds: number
  usage: Usage
  quotaHits: readonly string[]
}

type Attr = { key: string; value: { stringValue: string } }
type Point = { attributes: Attr[]; startTimeUnixNano?: string; timeUnixNano: string; asDouble: number }

const attrs = (o: Record<string, string>): Attr[] =>
  Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }))

const nanos = (ms: number) => `${Math.round(ms)}000000`

const resource = { attributes: attrs({ 'service.name': 'ia-relevo' }) }
const scope = { name: 'ia-relevo', version: '0.2.0' }

const sum = (name: string, unit: string, points: Point[]) => ({
  name,
  unit,
  sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points },
})

const gauge = (name: string, unit: string, points: Point[]) => ({ name, unit, gauge: { dataPoints: points } })

export const runMetrics = (run: RunEvent, nowMs: number) => {
  const base = { engine: run.engine, model: run.model, kind: run.kind, level: run.level }
  const point = (value: number, extra: Record<string, string> = {}): Point => ({
    attributes: attrs({ ...base, ...extra }),
    startTimeUnixNano: nanos(nowMs - 1),
    timeUnixNano: nanos(nowMs),
    asDouble: value,
  })
  const metrics = [
    sum('relevo.runs', '{run}', [point(1, { status: run.isOk ? 'ok' : 'failed', relayed: String(run.quotaHits.length > 0) })]),
    sum('relevo.run.duration', 's', [point(run.durationSeconds)]),
    sum('relevo.tokens', '{token}', [
      point(run.usage.fresh, { type: 'fresh' }),
      point(run.usage.cached, { type: 'cached' }),
      point(run.usage.output, { type: 'output' }),
    ]),
    sum('relevo.claude_equivalent', '{token}', [point(claudeEquivalent(run.usage))]),
  ]
  if (run.quotaHits.length > 0) {
    metrics.push(sum('relevo.quota_hits', '{hit}', run.quotaHits.map(engine => ({
      attributes: attrs({ engine }),
      startTimeUnixNano: nanos(nowMs - 1),
      timeUnixNano: nanos(nowMs),
      asDouble: 1,
    }))))
  }
  return { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] }
}

export type Limit = { window: string; percentUsed: number; resetsAt?: string }

export const limitMetrics = (limits: readonly Limit[], nowMs: number) => {
  const at = nanos(nowMs)
  const metrics = [
    gauge('relevo.plan.limit', '%', limits.map(l => ({
      attributes: attrs({ window: l.window }),
      timeUnixNano: at,
      asDouble: l.percentUsed,
    }))),
  ]
  const resets = limits.filter(l => l.resetsAt && Number.isFinite(Date.parse(l.resetsAt)))
  if (resets.length > 0) {
    metrics.push(gauge('relevo.plan.limit.resets_at', 's', resets.map(l => ({
      attributes: attrs({ window: l.window }),
      timeUnixNano: at,
      asDouble: Date.parse(l.resetsAt as string) / 1000,
    }))))
  }
  return { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] }
}

export const runLog = (run: RunEvent, nowMs: number) => ({
  resourceLogs: [{
    resource,
    scopeLogs: [{
      scope,
      logRecords: [{
        timeUnixNano: nanos(nowMs),
        severityText: run.isOk ? 'INFO' : 'WARN',
        body: { stringValue: `${run.name}: ${run.engine} ${run.model} ${run.isOk ? 'ok' : 'failed'} in ${Math.round(run.durationSeconds)}s` },
        attributes: attrs({
          'event.name': 'relevo.run',
          'relevo.name': run.name,
          engine: run.engine,
          model: run.model,
          kind: run.kind,
          level: run.level,
          status: run.isOk ? 'ok' : 'failed',
          quota_hits: run.quotaHits.join(','),
          claude_equivalent: String(claudeEquivalent(run.usage)),
        }),
      }],
    }],
  }],
})

// Engines that ran out of quota during the run, from its stderr log.
export const quotaHits = (stderr: string): string[] =>
  [...stderr.matchAll(/^relevo: (\w+) out of quota/gm)].map(m => m[1] as string)
