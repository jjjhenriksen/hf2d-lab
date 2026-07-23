import { describe, expect, it } from 'vitest'
import { packSpinOrbitals, unpackOrbitalFields, unpackSpinDensities } from './webgpu'

describe('WebGPU density data layout', () => {
  it('packs orbitals by spin and separates the two density fields', () => {
    const packed = packSpinOrbitals(
      [Float64Array.from([1, 2]), Float64Array.from([3, 4])],
      [Float64Array.from([5, 6])],
      2,
    )

    expect(packed.alphaCount).toBe(2)
    expect(packed.betaCount).toBe(1)
    expect(Array.from(packed.coefficients)).toEqual([1, 2, 3, 4, 5, 6])
    expect(unpackSpinDensities(Float32Array.from([10, 20, 30, 40]), 2)).toEqual({
      alpha: Float64Array.from([10, 20]),
      beta: Float64Array.from([30, 40]),
    })
  })

  it('unpacks batched kinetic fields after both spin densities', () => {
    expect(unpackOrbitalFields(Float32Array.from([
      10, 20,
      30, 40,
      1, 2,
      3, 4,
      5, 6,
    ]), 2, 2, 1)).toEqual({
      alpha: Float64Array.from([10, 20]),
      beta: Float64Array.from([30, 40]),
      alphaKinetic: [Float64Array.from([1, 2]), Float64Array.from([3, 4])],
      betaKinetic: [Float64Array.from([5, 6])],
    })
  })
})
