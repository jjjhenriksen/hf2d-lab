import { describe, expect, it } from 'vitest'
import { clonePreset } from './presets'
import { configSchema, validateConfig } from './schema'
import { spinOccupations } from './types'

describe('simulation contract', () => {
  it('derives RHF and UHF spin occupations', () => {
    expect(spinOccupations(4, 1, 'RHF')).toEqual({ alpha: 2, beta: 2 })
    expect(spinOccupations(3, 2, 'UHF')).toEqual({ alpha: 2, beta: 1 })
    expect(() => spinOccupations(3, 1, 'RHF')).toThrow(/even electron/)
  })

  it('accepts all guided fixtures', () => {
    expect(configSchema.safeParse(clonePreset('h2')).success).toBe(true)
    expect(configSchema.safeParse(clonePreset('triatomic')).success).toBe(true)
    expect(configSchema.safeParse(clonePreset('collision')).success).toBe(true)
  })

  it('defaults damping to zero for existing v1 configurations', () => {
    const legacy = structuredClone(clonePreset('h2')) as unknown as { dynamics: { damping?: number } }
    delete legacy.dynamics.damping
    expect(validateConfig(legacy).dynamics.damping).toBe(0)
  })

  it('accepts safe time-step overrides and rejects unsafe values', () => {
    const config = clonePreset('h2')
    config.dynamics.timeStep = 0.02
    expect(configSchema.safeParse(config).success).toBe(true)

    config.dynamics.timeStep = 0
    expect(configSchema.safeParse(config).success).toBe(false)
  })

  it('rejects incompatible multiplicity and out-of-buffer nuclei', () => {
    const spinInvalid = clonePreset('triatomic')
    spinInvalid.multiplicity = 1
    expect(configSchema.safeParse(spinInvalid).success).toBe(false)
    const boundaryInvalid = clonePreset('h2')
    boundaryInvalid.nuclei[0]!.position = [6.5, 0]
    expect(configSchema.safeParse(boundaryInvalid).success).toBe(false)
  })
})
