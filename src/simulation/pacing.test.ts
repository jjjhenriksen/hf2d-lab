import { describe, expect, it } from 'vitest'
import { pacingDelayMs, validateRunSpeed } from './pacing'

describe('continuous-run pacing', () => {
  it('paces accepted steps without adding delay when the solver is slower than the target', () => {
    expect(pacingDelayMs(2, 125)).toBe(375)
    expect(pacingDelayMs(2, 700)).toBe(0)
  })

  it('clamps invalid and out-of-range speeds', () => {
    expect(validateRunSpeed(Number.NaN)).toBe(1)
    expect(validateRunSpeed(0.01)).toBe(0.25)
    expect(validateRunSpeed(20)).toBe(4)
  })
})
