import { describe, expect, it } from 'vitest'
import { clonePreset } from './presets'
import { ReferenceHartreeFockEngine } from './reference-engine'

describe('real-space Hartree–Fock engine', () => {
  it('preserves orbital normalization in a finite SCF run', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 10
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    const spacing = 2 * config.domainRadius / config.gridSize
    const integral = snapshot.density.reduce((sum, value) => sum + value * spacing * spacing, 0)
    expect(integral).toBeCloseTo(config.electrons, 4)
    expect(Number.isFinite(snapshot.totalEnergy)).toBe(true)
    expect(snapshot.scf.iteration).toBe(10)
  }, 20000)

  it('makes paired UHF agree with RHF for the closed-shell fixture', async () => {
    const rhfConfig = clonePreset('h2')
    rhfConfig.scf.tolerance = 1e-5
    const uhfConfig = structuredClone(rhfConfig)
    uhfConfig.method = 'UHF'
    const rhf = await new ReferenceHartreeFockEngine(rhfConfig).initialize()
    const uhf = await new ReferenceHartreeFockEngine(uhfConfig).initialize()
    expect(rhf.scf.converged).toBe(true)
    expect(uhf.scf.converged).toBe(true)
    expect(uhf.totalEnergy).toBeCloseTo(rhf.totalEnergy, 8)
  }, 20000)

  it('accepts a convergence-gated Velocity Verlet step with bounded drift', async () => {
    const config = clonePreset('h2')
    config.scf.tolerance = 1e-5
    const engine = new ReferenceHartreeFockEngine(config)
    const initial = await engine.initialize()
    const stepped = await engine.step()
    expect(initial.scf.converged).toBe(true)
    expect(stepped.scf.converged).toBe(true)
    expect(stepped.time).toBeCloseTo(config.dynamics.timeStep, 12)
    expect(Math.abs(stepped.energyDrift)).toBeLessThan(1e-6)
  }, 20000)
})
