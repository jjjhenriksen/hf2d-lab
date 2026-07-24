import { describe, expect, it } from 'vitest'
import { gridSpacing, integrationLimits } from './discretization'
import { clonePreset } from './presets'
import { configSchema } from './schema'

describe('real-space discretization controls', () => {
  it('derives spacing and symmetric integration limits from the configured grid', () => {
    const config = clonePreset('h2')
    config.gridSize = 128
    config.domainRadius = 8

    expect(gridSpacing(config)).toBe(0.125)
    expect(integrationLimits(config.domainRadius)).toEqual([-8, 8])
    expect(configSchema.safeParse(config).success).toBe(true)
  })

  it('retains the orbital boundary buffer when the domain is edited', () => {
    const config = clonePreset('h2')
    config.domainRadius = 1

    expect(configSchema.safeParse(config).success).toBe(false)
  })
})
