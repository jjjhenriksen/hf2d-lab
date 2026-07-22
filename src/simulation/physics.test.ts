import { describe, expect, it } from 'vitest'
import { logarithmicKernel, nuclearEnergy, nuclearForces, pairEnergy, pairForce } from './physics'

describe('strict 2D logarithmic interaction', () => {
  it('uses an attractive opposite-charge and repulsive like-charge force', () => {
    const like = pairForce(1, 1, [1, 0], [0, 0], 0.2)
    const opposite = pairForce(1, -1, [1, 0], [0, 0], 0.2)
    expect(like[0]).toBeGreaterThan(0)
    expect(opposite[0]).toBeLessThan(0)
    expect(opposite[0]).toBeCloseTo(-like[0], 12)
  })

  it('matches the analytic force to a central energy difference', () => {
    const h = 1e-5
    const energyPlus = pairEnergy(1.2, -0.8, [1.1 + h, -0.3], [-0.2, 0.4], 0.35)
    const energyMinus = pairEnergy(1.2, -0.8, [1.1 - h, -0.3], [-0.2, 0.4], 0.35)
    const numericalForce = -(energyPlus - energyMinus) / (2 * h)
    expect(pairForce(1.2, -0.8, [1.1, -0.3], [-0.2, 0.4], 0.35)[0]).toBeCloseTo(numericalForce, 8)
  })

  it('is symmetric under relabeling and conserves pair momentum', () => {
    const nuclei = [
      { id: 'a', label: 'A', charge: 1, mass: 10, position: [-1, 0] as const, velocity: [0, 0] as const },
      { id: 'b', label: 'B', charge: 2, mass: 20, position: [2, 1] as const, velocity: [0, 0] as const },
    ]
    expect(nuclearEnergy(nuclei, 0.5)).toBeCloseTo(nuclearEnergy([...nuclei].reverse(), 0.5), 12)
    const forces = nuclearForces(nuclei, 0.5)
    expect(forces[0]![0] + forces[1]![0]).toBeCloseTo(0, 12)
    expect(forces[0]![1] + forces[1]![1]).toBeCloseTo(0, 12)
  })

  it('keeps the softened kernel finite at the origin', () => {
    expect(logarithmicKernel(0, 0.5)).toBeCloseTo(-Math.log(0.5), 12)
  })
})
