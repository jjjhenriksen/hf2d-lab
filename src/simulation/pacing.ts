export const MIN_RUN_SPEED = 0.25
export const MAX_RUN_SPEED = 4

export function validateRunSpeed(stepsPerSecond: number) {
  if (!Number.isFinite(stepsPerSecond)) return 1
  return Math.min(MAX_RUN_SPEED, Math.max(MIN_RUN_SPEED, stepsPerSecond))
}

export function pacingDelayMs(stepsPerSecond: number, elapsedMs: number) {
  const targetInterval = 1000 / validateRunSpeed(stepsPerSecond)
  return Math.max(0, targetInterval - Math.max(0, elapsedMs))
}
