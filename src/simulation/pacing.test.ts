import { describe, expect, it } from 'vitest'
import { pacingDelayMs, validateRunSpeed } from './pacing'

describe('continuous-run pacing', () => {
  it('paces accepted steps without adding delay when the solver is slower than the target', () => {
    expect(pacingDelayMs(2, 125)).toBe(375)
    expect(pacingDelayMs(2, 700)).toBe(0)
  })

  it('accepts any positive numeric speed without a preset ceiling', () => {
    expect(validateRunSpeed(0.1)).toBe(0.1)
    expect(validateRunSpeed(20)).toBe(20)
    expect(pacingDelayMs(20, 10)).toBe(40)
  })

  it('runs without an artificial delay in unlimited mode', () => {
    expect(validateRunSpeed(null)).toBeNull()
    expect(pacingDelayMs(null, 0)).toBe(0)
  })

  it('falls back safely for invalid numeric speeds', () => {
    expect(validateRunSpeed(Number.NaN)).toBe(1)
    expect(validateRunSpeed(0)).toBe(1)
    expect(validateRunSpeed(-2)).toBe(1)
  })
})
