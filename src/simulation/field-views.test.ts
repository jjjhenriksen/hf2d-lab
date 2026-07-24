import { describe, expect, it } from 'vitest'
import { fieldViewOptions, orbitalField, resolveFieldView } from './field-views'
import { clonePreset } from './presets'
import type { SimulationSnapshot } from './types'

describe('simulation field views', () => {
  it('lists paired spatial orbitals once for RHF', () => {
    const config = clonePreset('h2')
    config.electrons = 4

    expect(fieldViewOptions(config).map(({ id, label }) => [id, label])).toEqual([
      ['density', 'Electron density'],
      ['spin-density', 'Spin density'],
      ['orbital-alpha-0', 'Occupied orbital 1 · paired'],
      ['orbital-alpha-1', 'Occupied orbital 2 · paired'],
    ])
  })

  it('lists every occupied alpha and beta spin-orbital for UHF', () => {
    const config = clonePreset('triatomic')

    expect(fieldViewOptions(config).map(({ id }) => id)).toEqual([
      'density',
      'spin-density',
      'orbital-alpha-0',
      'orbital-alpha-1',
      'orbital-beta-0',
    ])
  })

  it('extracts exactly one orbital from a flattened worker buffer', () => {
    const flattened = Float32Array.from({ length: 12 }, (_, index) => index)

    expect(Array.from(orbitalField(flattened, 2, 1) ?? [])).toEqual([4, 5, 6, 7])
    expect(orbitalField(flattened, 2, 3)).toBeNull()
  })

  it('resolves a selected orbital as a signed field and contour', () => {
    const config = clonePreset('triatomic')
    config.gridSize = 64
    const points = config.gridSize ** 2
    const alpha = new Float32Array(points * 2)
    alpha.fill(-1, points, points * 2)
    const snapshot = {
      config,
      gridSize: config.gridSize,
      density: new Float32Array(points),
      spinDensity: new Float32Array(points),
      orbitalContours: new Float32Array(points),
      orbitalAlpha: alpha,
      orbitalBeta: new Float32Array(points),
    } as unknown as SimulationSnapshot

    const resolved = resolveFieldView(snapshot, 'orbital-alpha-1')

    expect(resolved.id).toBe('orbital-alpha-1')
    expect(resolved.label).toBe('α spin-orbital 2')
    expect(resolved.signed).toBe(true)
    expect(resolved.field).toBe(resolved.contour)
    expect(resolved.field.every((value) => value === -1)).toBe(true)
  })
})
