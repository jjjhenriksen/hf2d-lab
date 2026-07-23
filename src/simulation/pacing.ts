import type { RunSpeed } from './types'

export function validateRunSpeed(stepsPerSecond: RunSpeed): RunSpeed {
  if (stepsPerSecond === null) return null
  if (!Number.isFinite(stepsPerSecond) || stepsPerSecond <= 0) return 1
  return stepsPerSecond
}

export function pacingDelayMs(stepsPerSecond: RunSpeed, elapsedMs: number) {
  const validatedSpeed = validateRunSpeed(stepsPerSecond)
  if (validatedSpeed === null) return 0
  const targetInterval = 1000 / validatedSpeed
  return Math.max(0, targetInterval - Math.max(0, elapsedMs))
}
