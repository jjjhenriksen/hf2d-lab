import { describe, expect, it } from 'vitest'
import { OpenBoundaryConvolver } from './fft2d'
import { clonePreset } from './presets'
import { andersonCoefficients, ReferenceHartreeFockEngine, residualMixingStep } from './reference-engine'

describe('real-space Hartree–Fock engine', () => {
  it('applies residual mixing literally without a stability clamp', () => {
    expect(residualMixingStep(0)).toBe(0)
    expect(residualMixingStep(-0.5)).toBe(-1)
    expect(residualMixingStep(10)).toBe(20)
  })

  it('builds finite Pulay coefficients that preserve the affine constraint', () => {
    const coefficients = andersonCoefficients([
      [Float64Array.from([1, 0])],
      [Float64Array.from([0, 1])],
    ], 1e-8)
    expect(coefficients).not.toBeNull()
    expect(Array.from(coefficients ?? []).every(Number.isFinite)).toBe(true)
    expect(Array.from(coefficients ?? []).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
  })

  it('runs the configured Anderson acceleration path with finite output', async () => {
    const config = clonePreset('h2')
    config.scf.acceleration = 'anderson'
    config.scf.andersonHistory = 3
    config.scf.andersonRegularization = 1e-8
    config.scf.maxIterations = 8
    config.scf.tolerance = 1e-20
    config.scf.energyTolerance = 1e-20
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    expect(snapshot.scf.iteration).toBe(8)
    expect(Number.isFinite(snapshot.totalEnergy)).toBe(true)
    expect(snapshot.density.every(Number.isFinite)).toBe(true)
  }, 20000)

  it('solves a zero-electron system exactly without SCF iterations', async () => {
    const config = clonePreset('h2')
    config.electrons = 0
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.message).toContain('exact nuclear-only')
    expect(snapshot.scf.converged).toBe(true)
    expect(snapshot.scf.iteration).toBe(0)
    expect(snapshot.scf.residual).toBe(0)
    expect(snapshot.scf.history).toEqual([{ iteration: 0, residual: 0, energy: snapshot.energies.nuclear }])
    expect(snapshot.density.every((value) => value === 0)).toBe(true)
    expect(snapshot.scf.densityIntegral).toBe(0)
  }, 20000)

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

  it('can retain the latest nonconverged iterate for approximate dynamics', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 4
    config.scf.tolerance = 1e-20
    config.scf.energyTolerance = 1e-20
    config.scf.approximateDynamicsPolicy = 'latest-iteration'
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    const latest = snapshot.scf.history.at(-1)!
    const retainedElectronicEnergy = snapshot.energies.kinetic
      + snapshot.energies.electronNuclear
      + snapshot.energies.hartree
      + snapshot.energies.exchange
      + snapshot.energies.nuclear

    expect(snapshot.scf.converged).toBe(false)
    expect(snapshot.scf.usedLatestIteration).toBe(true)
    expect(snapshot.scf.usedBestIteration).toBe(false)
    expect(snapshot.scf.latestIteration).toBe(latest.iteration)
    expect(retainedElectronicEnergy).toBeCloseTo(latest.energy, 10)
    expect(snapshot.message).toContain(`retained latest iteration ${latest.iteration}`)
  }, 20000)

  it('turns cancellation into a max-iteration checkpoint', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 12
    config.scf.tolerance = 1e-20
    config.scf.energyTolerance = 1e-20
    const engine = new ReferenceHartreeFockEngine(config)
    const snapshot = await engine.initialize((iteration) => {
      if (iteration === 1) engine.cancel()
    })
    expect(snapshot.status).toBe('failed')
    expect(snapshot.scf.stoppedEarly).toBe(true)
    expect(snapshot.scf.converged).toBe(false)
    expect(snapshot.scf.iteration).toBe(config.scf.maxIterations)
    expect(snapshot.scf.latestIteration).toBe(1)
    expect(snapshot.message).toContain('max-iteration checkpoint')
  }, 20000)

  it('resets to the solved checkpoint without running SCF again', async () => {
    const config = clonePreset('h2')
    const engine = new ReferenceHartreeFockEngine(config)
    const initial = await engine.initialize()
    await engine.step()
    const reset = engine.reset()
    expect(reset.status).toBe('ready')
    expect(reset.message).toContain('last solved checkpoint')
    expect(reset.time).toBe(0)
    expect(reset.step).toBe(0)
    expect(reset.trajectory).toHaveLength(1)
    expect(reset.totalEnergy).toBeCloseTo(initial.totalEnergy, 10)
  }, 20000)

  it('preserves dynamics state while applying non-structural parameters', async () => {
    const config = clonePreset('h2')
    const engine = new ReferenceHartreeFockEngine(config)
    await engine.initialize()
    const stepped = await engine.step()
    const next = structuredClone(config)
    next.scf.tolerance = 1e-5
    next.dynamics.damping = 2
    const reconfigured = await engine.reconfigure(next)
    expect(reconfigured.time).toBeCloseTo(stepped.time, 12)
    expect(reconfigured.step).toBe(stepped.step)
    expect(reconfigured.nuclei[0]?.position).toEqual(stepped.nuclei[0]?.position)
    expect(reconfigured.trajectory.length).toBeGreaterThan(1)
  }, 20000)

  it('uses the current state as the reset baseline on request', async () => {
    const config = clonePreset('h2')
    const engine = new ReferenceHartreeFockEngine(config)
    await engine.initialize()
    const baseline = await engine.step()
    const marked = engine.setResetBaseline()
    await engine.step()
    const reset = engine.reset()
    expect(marked.message).toContain('reset baseline')
    expect(reset.time).toBeCloseTo(baseline.time, 12)
    expect(reset.step).toBe(baseline.step)
    expect(reset.nuclei[0]?.position).toEqual(baseline.nuclei[0]?.position)
  }, 20000)

  it('computes finite virtual orbitals and energies within the configured budget', async () => {
    const config = clonePreset('h2')
    config.scf.virtualOrbitals = 2
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    expect(snapshot.virtualOrbitalAlpha).toHaveLength(config.scf.virtualOrbitals * config.gridSize ** 2)
    expect(snapshot.virtualOrbitalBeta).toHaveLength(config.scf.virtualOrbitals * config.gridSize ** 2)
    expect(snapshot.orbitalEnergiesAlpha).toHaveLength(snapshot.orbitalCounts.occupiedAlpha + config.scf.virtualOrbitals)
    expect(snapshot.orbitalEnergiesBeta).toHaveLength(snapshot.orbitalCounts.occupiedBeta + config.scf.virtualOrbitals)
    expect(snapshot.orbitalEnergiesAlpha?.every(Number.isFinite)).toBe(true)
    expect(snapshot.virtualOrbitalAlpha?.every(Number.isFinite)).toBe(true)
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

  it('selects and tunes the configured convergence acceleration path', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 3
    config.scf.tolerance = 1e-20
    config.scf.energyTolerance = 1e-20
    const spacing = 2 * config.domainRadius / config.gridSize
    const reference = new OpenBoundaryConvolver(config.gridSize, spacing, config.softening, config.referenceLength)
    const shifts: number[] = []
    const convolver = {
      convolve: (field: Float64Array) => reference.convolve(field),
      precondition: (field: Float64Array, shift?: number) => {
        shifts.push(shift ?? 0)
        return reference.precondition(field, shift)
      },
    }

    config.scf.acceleration = 'none'
    await new ReferenceHartreeFockEngine(config, { convolver }).initialize()
    expect(shifts).toEqual([])

    config.scf.acceleration = 'kinetic-preconditioner'
    config.scf.preconditionerShift = 0.75
    await new ReferenceHartreeFockEngine(config, { convolver }).initialize()
    expect(shifts.length).toBeGreaterThan(0)
    expect(shifts.every((shift) => shift === 0.75)).toBe(true)
  }, 20000)
})
