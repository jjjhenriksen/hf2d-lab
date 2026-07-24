import { describe, expect, it } from 'vitest'
import { sameSimulationConfig } from './config-state'
import { clonePreset } from './presets'

describe('staged simulation configuration', () => {
  it('marks an edited draft as different from the applied SCF configuration', () => {
    const applied = clonePreset('h2')
    const draft = structuredClone(applied)
    draft.softening = 0.75

    expect(sameSimulationConfig(draft, applied)).toBe(false)
    expect(sameSimulationConfig(structuredClone(draft), draft)).toBe(true)
  })
})
