import { describe, expect, it } from 'vitest'
import { OpenBoundaryConvolver } from './fft2d'
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
    expect(snapshot.scf.densityIntegral).toBeCloseTo(config.electrons, 8)
    expect(Number.isFinite(snapshot.totalEnergy)).toBe(true)
    expect(snapshot.scf.durationMs ?? 0).toBeGreaterThan(0)
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

  it('dissipates nuclear motion when damping is enabled', async () => {
    const undampedConfig = clonePreset('h2')
    undampedConfig.scf.tolerance = 1e-5
    const dampedConfig = structuredClone(undampedConfig)
    dampedConfig.dynamics.damping = 100

    const undamped = new ReferenceHartreeFockEngine(undampedConfig)
    const damped = new ReferenceHartreeFockEngine(dampedConfig)
    await Promise.all([undamped.initialize(), damped.initialize()])
    const [undampedStep, dampedStep] = await Promise.all([undamped.step(), damped.step()])

    expect(dampedStep.energies.nuclearKinetic).toBeLessThan(undampedStep.energies.nuclearKinetic)
  }, 20000)

  it('uses an injected density accelerator for the WebGPU hybrid path', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 10
    let calls = 0
    const densityAccelerator = {
      densities: async (alpha: Float64Array[], beta: Float64Array[], points: number) => {
        calls += 1
        const density = (orbitals: Float64Array[]) => {
          const values = new Float64Array(points)
          for (const orbital of orbitals) for (let index = 0; index < points; index += 1) values[index] = values[index]! + orbital[index]! ** 2
          return values
        }
        return { alpha: density(alpha), beta: density(beta) }
      },
    }

    const snapshot = await new ReferenceHartreeFockEngine(config, { backend: 'webgpu', densityAccelerator }).initialize()

    expect(calls).toBe(snapshot.scf.iteration)
    expect(snapshot.backend).toBe('webgpu')
    expect(snapshot.density.every(Number.isFinite)).toBe(true)
  }, 20000)

  it('accepts an asynchronous convolver without changing reference results', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 10
    const spacing = 2 * config.domainRadius / config.gridSize
    const reference = new OpenBoundaryConvolver(config.gridSize, spacing, config.softening, config.referenceLength)
    const asynchronous = {
      convolve: async (field: Float64Array) => reference.convolve(field),
      precondition: async (field: Float64Array, shift?: number) => reference.precondition(field, shift),
    }

    const [synchronousSnapshot, asynchronousSnapshot] = await Promise.all([
      new ReferenceHartreeFockEngine(config).initialize(),
      new ReferenceHartreeFockEngine(config, { convolver: asynchronous }).initialize(),
    ])

    expect(asynchronousSnapshot.totalEnergy).toBeCloseTo(synchronousSnapshot.totalEnergy, 10)
    expect(asynchronousSnapshot.scf.residual).toBeCloseTo(synchronousSnapshot.scf.residual, 10)
  }, 20000)

  it('restores the lowest-energy iterate after a nonconverged solve', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 4
    config.scf.tolerance = 1e-20
    config.scf.energyTolerance = 1e-20

    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    const best = snapshot.scf.history.reduce((lowest, entry) => entry.energy < lowest.energy ? entry : lowest)
    const retainedElectronicEnergy = snapshot.energies.kinetic
      + snapshot.energies.electronNuclear
      + snapshot.energies.hartree
      + snapshot.energies.exchange
      + snapshot.energies.nuclear

    expect(snapshot.scf.converged).toBe(false)
    expect(snapshot.scf.usedBestIteration).toBe(true)
    expect(snapshot.scf.bestIteration).toBe(best.iteration)
    expect(retainedElectronicEnergy).toBeCloseTo(best.energy, 10)
    expect(snapshot.message).toContain(`retained lowest-energy iteration ${best.iteration}`)
  }, 20000)

  it('requires an explicit opt-in before stepping from the retained iterate', async () => {
    const strictConfig = clonePreset('h2')
    strictConfig.scf.maxIterations = 4
    strictConfig.scf.tolerance = 1e-20
    strictConfig.scf.energyTolerance = 1e-20
    const strictEngine = new ReferenceHartreeFockEngine(strictConfig)
    await strictEngine.initialize()
    await expect(strictEngine.step()).rejects.toThrow('Enable approximate dynamics')

    const approximateConfig = structuredClone(strictConfig)
    approximateConfig.scf.allowUnconvergedDynamics = true
    const approximateEngine = new ReferenceHartreeFockEngine(approximateConfig)
    const initial = await approximateEngine.initialize()
    const stepped = await approximateEngine.step()

    expect(initial.status).toBe('ready')
    expect(initial.scf.converged).toBe(false)
    expect(stepped.status).toBe('paused')
    expect(stepped.scf.usedBestIteration).toBe(true)
    expect(stepped.time).toBeCloseTo(approximateConfig.dynamics.timeStep, 12)
    expect(stepped.message).toContain('Accepted approximate step')
  }, 20000)
})
