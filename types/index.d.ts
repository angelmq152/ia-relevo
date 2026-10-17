export type RelevoRun = {
  dir: string
  name: string
  kind: string
  level: string
  startedAt: number
  isDone: boolean
}

export type RelevoLimits = {
  fiveHour?: number
  weekly?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ia-relevo': { runs: RelevoRun[]; limits: RelevoLimits }
  }
}
