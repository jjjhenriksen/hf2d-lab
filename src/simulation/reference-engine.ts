import { OpenBoundaryConvolver, type EngineConvolver } from './fft2d'
import { nuclearEnergy, nuclearForces } from './physics'
import { spinOccupations, type ActiveBackend, type EnergyComponents, type Nucleus, type SimulationConfig, type SimulationSnapshot, type TrajectoryPoint, type Vector2 } from './types'

type ProgressCallback = (iteration: number, residual: number, energy: number) => void

export const WEBGPU_RESIDUAL_FLOOR = 2e-5

interface SolveResult {
  density: Float64Array
  spinDensity: Float64Array
  energies: EnergyComponents
  totalEnergy: number
  residual: number
  durationMs: number
  iteration: number
  bestIteration: number
  usedBestIteration: boolean
  energyDelta: number
  converged: boolean
  history: Array<{ iteration: number; residual: number; energy: number }>
}

export interface DensityAccelerator {
  densities: (alpha: Float64Array[], beta: Float64Array[], points: number, gridSize: number, spacing: number) => Promise<{
    alpha: Float64Array
    beta: Float64Array
    alphaKinetic?: Float64Array[]
    betaKinetic?: Float64Array[]
  }>
}

interface EngineOptions {
  convolver?: EngineConvolver
  makeConvolver?: (config: SimulationConfig) => EngineConvolver
  backend?: ActiveBackend
  densityAccelerator?: DensityAccelerator
}

const copyNuclei = (nuclei: Nucleus[]): Nucleus[] => nuclei.map((nucleus) => ({
  ...nucleus,
  position: [...nucleus.position] as Vector2,
  velocity: [...nucleus.velocity] as Vector2,
}))

export class ReferenceHartreeFockEngine {
  readonly backend: ActiveBackend
  readonly precision: 'float32' | 'float64'
  private config: SimulationConfig
  private orbitalsAlpha: Float64Array[] = []
  private orbitalsBeta: Float64Array[] = []
  private convolver: EngineConvolver
  private readonly makeConvolver: (config: SimulationConfig) => EngineConvolver
  private readonly densityAccelerator?: DensityAccelerator
  private spacing: number
  private externalPotential: Float64Array
  private initialEnergy = Number.NaN
  private time = 0
  private stepIndex = 0
  private trajectory: TrajectoryPoint[] = []
  private lastSolve: SolveResult | null = null
  private cancelled = false

  constructor(config: SimulationConfig, options?: EngineOptions) {
    this.config = structuredClone(config)
    this.backend = options?.backend ?? 'typescript'
    this.precision = this.backend === 'webgpu' ? 'float32' : 'float64'
    this.spacing = (2 * config.domainRadius) / config.gridSize
    this.makeConvolver = options?.makeConvolver ?? ((next) => new OpenBoundaryConvolver(next.gridSize, 2 * next.domainRadius / next.gridSize, next.softening, next.referenceLength))
    this.convolver = options?.convolver ?? this.makeConvolver(config)
    this.densityAccelerator = options?.densityAccelerator
    this.externalPotential = this.buildExternalPotential()
    this.initializeOrbitals()
  }

  cancel() {
    this.cancelled = true
  }

  async initialize(progress?: ProgressCallback) {
    this.cancelled = false
    const result = await this.solve(progress)
    this.lastSolve = result
    this.initialEnergy = result.totalEnergy
    this.trajectory = [this.trajectoryPoint(result)]
    const canUseApproximate = this.config.scf.allowUnconvergedDynamics && result.usedBestIteration
    return this.snapshot(
      result,
      result.converged || canUseApproximate ? 'ready' : 'failed',
      result.converged
        ? 'SCF converged'
        : canUseApproximate
          ? `SCF did not converge; using lowest-energy iteration ${result.bestIteration} with approximate dynamics enabled`
          : `SCF did not converge; retained lowest-energy iteration ${result.bestIteration}`,
    )
  }

  async reconfigure(config: SimulationConfig, progress?: ProgressCallback) {
    this.config = structuredClone(config)
    this.spacing = (2 * config.domainRadius) / config.gridSize
    this.convolver = this.makeConvolver(config)
    this.externalPotential = this.buildExternalPotential()
    this.time = 0
    this.stepIndex = 0
    this.initialEnergy = Number.NaN
    this.trajectory = []
    this.initializeOrbitals()
    return this.initialize(progress)
  }

  async step(progress?: ProgressCallback) {
    if (!this.lastSolve?.converged && !(this.config.scf.allowUnconvergedDynamics && this.lastSolve?.usedBestIteration)) {
      throw new Error('A converged SCF state is required before a dynamics step. Enable approximate dynamics to use the retained lowest-energy iterate.')
    }
    const previousNuclei = copyNuclei(this.config.nuclei)
    const previousAlpha = this.orbitalsAlpha.map((orbital) => orbital.slice())
    const previousBeta = this.orbitalsBeta.map((orbital) => orbital.slice())
    const previousSolve = this.lastSolve
    const dt = this.config.dynamics.timeStep
    const dampingHalfStep = Math.exp(-0.5 * this.config.dynamics.damping * dt)
    const oldForces = this.forces(previousSolve.density)

    this.config.nuclei = this.config.nuclei.map((nucleus, index) => {
      const force = oldForces[index]!
      const halfVelocity: Vector2 = [
        nucleus.velocity[0] * dampingHalfStep + 0.5 * dt * force[0] / nucleus.mass,
        nucleus.velocity[1] * dampingHalfStep + 0.5 * dt * force[1] / nucleus.mass,
      ]
      return {
        ...nucleus,
        velocity: halfVelocity,
        position: [nucleus.position[0] + dt * halfVelocity[0], nucleus.position[1] + dt * halfVelocity[1]],
      }
    })

    const margin = this.config.domainRadius * 0.86
    if (this.config.nuclei.some((nucleus) => Math.abs(nucleus.position[0]) >= margin || Math.abs(nucleus.position[1]) >= margin)) {
      this.config.nuclei = previousNuclei
      throw new Error('A nucleus entered the orbital boundary buffer. The accepted step was restored.')
    }

    this.externalPotential = this.buildExternalPotential()
    const result = await this.solve(progress)
    const canUseApproximate = this.config.scf.allowUnconvergedDynamics && result.usedBestIteration
    if (!result.converged && !canUseApproximate) {
      this.config.nuclei = previousNuclei
      this.orbitalsAlpha = previousAlpha
      this.orbitalsBeta = previousBeta
      this.externalPotential = this.buildExternalPotential()
      this.lastSolve = previousSolve
      throw new Error('SCF failed at the proposed geometry. The accepted step was restored.')
    }

    const newForces = this.forces(result.density)
    this.config.nuclei = this.config.nuclei.map((nucleus, index) => ({
      ...nucleus,
      velocity: [
        (nucleus.velocity[0] + 0.5 * dt * newForces[index]![0] / nucleus.mass) * dampingHalfStep,
        (nucleus.velocity[1] + 0.5 * dt * newForces[index]![1] / nucleus.mass) * dampingHalfStep,
      ],
    }))
    this.time += dt
    this.stepIndex += 1
    this.lastSolve = result
    this.trajectory.push(this.trajectoryPoint(result))
    if (this.trajectory.length > 600) this.trajectory.shift()
    return this.snapshot(
      result,
      'paused',
      result.converged
        ? 'Accepted converged Born–Oppenheimer step'
        : `Accepted approximate step from lowest-energy SCF iteration ${result.bestIteration}`,
    )
  }

  private async solve(progress?: ProgressCallback): Promise<SolveResult> {
    const startedAt = performance.now()
    const history: SolveResult['history'] = []
    let previousEnergy = Number.POSITIVE_INFINITY
    let residual = Number.POSITIVE_INFINITY
    let components: EnergyComponents = this.emptyComponents()
    let density = new Float64Array(this.config.gridSize ** 2)
    let spinDensity = density.slice()
    let converged = false
    let iteration = 0
    let best: {
      energy: number
      iteration: number
      residual: number
      energyDelta: number
      density: Float64Array
      spinDensity: Float64Array
      components: EnergyComponents
      orbitalsAlpha: Float64Array[]
      orbitalsBeta: Float64Array[]
    } | null = null
    const effectiveTolerance = this.backend === 'webgpu'
      ? Math.max(this.config.scf.tolerance, WEBGPU_RESIDUAL_FLOOR)
      : this.config.scf.tolerance

    for (iteration = 1; iteration <= this.config.scf.maxIterations; iteration += 1) {
      if (this.cancelled) throw new Error('Calculation cancelled.')
      const isRestricted = this.config.method === 'RHF'
      const accelerated = await this.densityAccelerator?.densities(
        this.orbitalsAlpha,
        isRestricted ? [] : this.orbitalsBeta,
        this.config.gridSize ** 2,
        this.config.gridSize,
        this.spacing,
      )
      const alphaDensity = accelerated?.alpha ?? this.density(this.orbitalsAlpha)
      const betaDensity = isRestricted ? alphaDensity : accelerated?.beta ?? this.density(this.orbitalsBeta)
      density = addFields(alphaDensity, betaDensity)
      spinDensity = subtractFields(alphaDensity, betaDensity)
      const hartreePotential = await this.convolver.convolve(density)
      const alphaFock = await this.applyFock(this.orbitalsAlpha, hartreePotential, accelerated?.alphaKinetic)
      const betaFock = isRestricted
        ? {
            orbitals: alphaFock.orbitals.map((field) => field.slice()),
            kinetic: alphaFock.kinetic.map((field) => field.slice()),
            exchangeEnergy: alphaFock.exchangeEnergy,
          }
        : await this.applyFock(this.orbitalsBeta, hartreePotential, accelerated?.betaKinetic)
      const alphaResiduals = this.orbitalResiduals(this.orbitalsAlpha, alphaFock.orbitals)
      const betaResiduals = isRestricted ? alphaResiduals : this.orbitalResiduals(this.orbitalsBeta, betaFock.orbitals)
      residual = Math.max(fieldSetNorm(alphaResiduals, this.spacing), fieldSetNorm(betaResiduals, this.spacing))
      components = this.energyComponents(
        density,
        hartreePotential,
        this.orbitalsAlpha,
        this.orbitalsBeta,
        alphaFock.kinetic,
        betaFock.kinetic,
        alphaFock.exchangeEnergy + betaFock.exchangeEnergy,
      )
      const electronic = components.kinetic + components.electronNuclear + components.hartree + components.exchange + components.nuclear
      const energyDelta = Math.abs(electronic - previousEnergy)
      history.push({ iteration, residual, energy: electronic })
      if (history.length > 240) history.shift()
      progress?.(iteration, residual, electronic)

      if (Number.isFinite(electronic) && Number.isFinite(residual) && (!best || electronic < best.energy)) {
        best = {
          energy: electronic,
          iteration,
          residual,
          energyDelta: Number.isFinite(energyDelta) ? energyDelta : 0,
          density: density.slice(),
          spinDensity: spinDensity.slice(),
          components: { ...components },
          orbitalsAlpha: this.orbitalsAlpha.map((orbital) => orbital.slice()),
          orbitalsBeta: this.orbitalsBeta.map((orbital) => orbital.slice()),
        }
      }

      if (residual <= effectiveTolerance && energyDelta <= Math.max(this.config.scf.energyTolerance, 1e-7)) {
        converged = true
        break
      }
      const step = Math.min(0.65, Math.max(0.01, this.config.scf.mixing * 2))
      const alphaDirection = this.config.scf.acceleration === 'kinetic-preconditioner'
        ? await Promise.all(alphaResiduals.map((field) => this.convolver.precondition(field, this.config.scf.preconditionerShift)))
        : alphaResiduals
      this.orbitalsAlpha = updateOrbitals(this.orbitalsAlpha, alphaDirection, step, this.spacing)
      if (isRestricted) this.orbitalsBeta = this.orbitalsAlpha.map((orbital) => orbital.slice())
      else {
        const betaDirection = this.config.scf.acceleration === 'kinetic-preconditioner'
          ? await Promise.all(betaResiduals.map((field) => this.convolver.precondition(field, this.config.scf.preconditionerShift)))
          : betaResiduals
        this.orbitalsBeta = updateOrbitals(this.orbitalsBeta, betaDirection, step, this.spacing)
      }
      previousEnergy = electronic
      if (iteration % 4 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }

    iteration = Math.min(iteration, this.config.scf.maxIterations)
    const usedBestIteration = !converged && best !== null
    if (usedBestIteration && best) {
      density = best.density
      spinDensity = best.spinDensity
      components = best.components
      residual = best.residual
      this.orbitalsAlpha = best.orbitalsAlpha
      this.orbitalsBeta = best.orbitalsBeta
    }
    components.nuclearKinetic = this.nuclearKineticEnergy()
    const totalEnergy = Object.values(components).reduce((sum, value) => sum + value, 0)
    return {
      density,
      spinDensity,
      energies: components,
      totalEnergy,
      residual,
      durationMs: performance.now() - startedAt,
      iteration,
      bestIteration: best?.iteration ?? iteration,
      usedBestIteration,
      energyDelta: usedBestIteration && best ? best.energyDelta : history.length > 1 ? Math.abs(history.at(-1)!.energy - history.at(-2)!.energy) : 0,
      converged,
      history,
    }
  }

  private initializeOrbitals() {
    const { alpha, beta } = spinOccupations(this.config.electrons, this.config.multiplicity, this.config.method)
    this.orbitalsAlpha = this.seedOrbitals(alpha, 0)
    this.orbitalsBeta = this.config.method === 'RHF'
      ? this.orbitalsAlpha.map((orbital) => orbital.slice())
      : this.seedOrbitals(beta, this.config.multiplicity === 1 ? 0 : 1)
  }

  private seedOrbitals(count: number, spinOffset: number) {
    const n = this.config.gridSize
    const fields: Float64Array[] = []
    for (let orbitalIndex = 0; orbitalIndex < count; orbitalIndex += 1) {
      const field = new Float64Array(n * n)
      const center = this.config.nuclei[(orbitalIndex + spinOffset) % this.config.nuclei.length]!
      for (let y = 0; y < n; y += 1) {
        const py = -this.config.domainRadius + (y + 0.5) * this.spacing
        for (let x = 0; x < n; x += 1) {
          const px = -this.config.domainRadius + (x + 0.5) * this.spacing
          let value = 0
          for (const nucleus of this.config.nuclei) {
            const dx = px - nucleus.position[0]
            const dy = py - nucleus.position[1]
            value += nucleus.charge * Math.exp(-0.42 * (dx * dx + dy * dy))
          }
          const dx = px - center.position[0]
          const dy = py - center.position[1]
          const mode = orbitalIndex % 6
          const polynomial = mode === 0 ? 1 : mode === 1 ? dx : mode === 2 ? dy : mode === 3 ? dx * dy : mode === 4 ? dx * dx - dy * dy : 1 - 0.3 * (dx * dx + dy * dy)
          field[y * n + x] = value * polynomial + 1e-4 * pseudoRandom(x, y, orbitalIndex + spinOffset * 17, this.config.seed)
        }
      }
      fields.push(field)
    }
    return orthonormalize(fields, this.spacing)
  }

  private buildExternalPotential() {
    const n = this.config.gridSize
    const field = new Float64Array(n * n)
    for (let y = 0; y < n; y += 1) {
      const py = -this.config.domainRadius + (y + 0.5) * this.spacing
      for (let x = 0; x < n; x += 1) {
        const px = -this.config.domainRadius + (x + 0.5) * this.spacing
        let potential = 0
        for (const nucleus of this.config.nuclei) {
          const dx = px - nucleus.position[0]
          const dy = py - nucleus.position[1]
          potential += 0.5 * nucleus.charge * Math.log((dx * dx + dy * dy + this.config.softening ** 2) / this.config.referenceLength ** 2)
        }
        field[y * n + x] = this.config.coupling * potential
      }
    }
    return field
  }

  private density(orbitals: Float64Array[]) {
    const result = new Float64Array(this.config.gridSize ** 2)
    for (const orbital of orbitals) for (let i = 0; i < result.length; i += 1) result[i] = result[i]! + orbital[i]! * orbital[i]!
    return result
  }

  private async applyFock(orbitals: Float64Array[], hartreePotential: Float64Array, acceleratedKinetic?: Float64Array[]) {
    let exchangeEnergy = 0
    const kinetic = acceleratedKinetic ?? orbitals.map((orbital) => applyKinetic(orbital, this.config.gridSize, this.spacing))
    const fockOrbitals: Float64Array[] = []
    for (let orbitalIndex = 0; orbitalIndex < orbitals.length; orbitalIndex += 1) {
      const orbital = orbitals[orbitalIndex]!
      const result = new Float64Array(orbital.length)
      for (let i = 0; i < result.length; i += 1) result[i] = kinetic[orbitalIndex]![i]! + (this.externalPotential[i]! + hartreePotential[i]!) * orbital[i]!
      for (const occupied of orbitals) {
        const pairDensity = multiplyFields(occupied, orbital)
        const exchangePotential = await this.convolver.convolve(pairDensity)
        exchangeEnergy -= 0.5 * innerProduct(pairDensity, exchangePotential, this.spacing)
        for (let i = 0; i < result.length; i += 1) result[i] = result[i]! - occupied[i]! * exchangePotential[i]!
      }
      fockOrbitals.push(result)
    }
    return { orbitals: fockOrbitals, kinetic, exchangeEnergy }
  }

  private orbitalResiduals(orbitals: Float64Array[], fockOrbitals: Float64Array[]) {
    return fockOrbitals.map((fock, i) => {
      const residual = fock.slice()
      for (let j = 0; j < orbitals.length; j += 1) {
        const coefficient = innerProduct(orbitals[j]!, fock, this.spacing)
        for (let k = 0; k < residual.length; k += 1) residual[k] = residual[k]! - coefficient * orbitals[j]![k]!
      }
      return residual
    })
  }

  private energyComponents(
    density: Float64Array,
    hartreePotential: Float64Array,
    alpha: Float64Array[],
    beta: Float64Array[],
    alphaKinetic: Float64Array[],
    betaKinetic: Float64Array[],
    exchange: number,
  ): EnergyComponents {
    const area = this.spacing * this.spacing
    let kinetic = 0
    for (let index = 0; index < alpha.length; index += 1) kinetic += innerProduct(alpha[index]!, alphaKinetic[index]!, this.spacing)
    for (let index = 0; index < beta.length; index += 1) kinetic += innerProduct(beta[index]!, betaKinetic[index]!, this.spacing)
    let electronNuclear = 0
    let hartree = 0
    for (let i = 0; i < density.length; i += 1) {
      electronNuclear += density[i]! * this.externalPotential[i]! * area
      hartree += 0.5 * density[i]! * hartreePotential[i]! * area
    }
    return {
      kinetic,
      electronNuclear,
      hartree,
      exchange,
      nuclear: nuclearEnergy(this.config.nuclei, this.config.softening, this.config.referenceLength),
      nuclearKinetic: 0,
    }
  }

  private forces(density: Float64Array) {
    const forces = nuclearForces(this.config.nuclei, this.config.softening).map((force) => [...force] as [number, number])
    const n = this.config.gridSize
    const area = this.spacing * this.spacing
    for (let a = 0; a < this.config.nuclei.length; a += 1) {
      const nucleus = this.config.nuclei[a]!
      for (let y = 0; y < n; y += 1) {
        const py = -this.config.domainRadius + (y + 0.5) * this.spacing
        for (let x = 0; x < n; x += 1) {
          const px = -this.config.domainRadius + (x + 0.5) * this.spacing
          const dx = nucleus.position[0] - px
          const dy = nucleus.position[1] - py
          const scale = -this.config.coupling * nucleus.charge * density[y * n + x]! * area / (dx * dx + dy * dy + this.config.softening ** 2)
          forces[a]![0] += scale * dx
          forces[a]![1] += scale * dy
        }
      }
    }
    return forces
  }

  private nuclearKineticEnergy() {
    return this.config.nuclei.reduce((sum, nucleus) => sum + 0.5 * nucleus.mass * (nucleus.velocity[0] ** 2 + nucleus.velocity[1] ** 2), 0)
  }

  private trajectoryPoint(result: SolveResult): TrajectoryPoint {
    const kinetic = this.nuclearKineticEnergy()
    const totalEnergy = result.totalEnergy - result.energies.nuclearKinetic + kinetic
    return {
      step: this.stepIndex,
      time: this.time,
      totalEnergy,
      energyDrift: Number.isFinite(this.initialEnergy) ? totalEnergy - this.initialEnergy : 0,
      residual: result.residual,
      positions: this.config.nuclei.map((nucleus) => [...nucleus.position] as Vector2),
    }
  }

  private snapshot(result: SolveResult, status: SimulationSnapshot['status'], message: string): SimulationSnapshot {
    const point = this.trajectoryPoint(result)
    const flatten = (orbitals: Float64Array[]) => Float32Array.from(orbitals.flatMap((orbital) => Array.from(orbital)))
    return {
      schema: 'hf2d-snapshot/v1',
      status,
      message,
      backend: this.backend,
      precision: this.precision,
      time: this.time,
      step: this.stepIndex,
      config: structuredClone(this.config),
      nuclei: copyNuclei(this.config.nuclei),
      density: Float32Array.from(result.density),
      spinDensity: Float32Array.from(result.spinDensity),
      orbitalContours: Float32Array.from(this.orbitalsAlpha[0] ?? result.density),
      orbitalAlpha: flatten(this.orbitalsAlpha),
      orbitalBeta: flatten(this.orbitalsBeta),
      gridSize: this.config.gridSize,
      energies: { ...result.energies, nuclearKinetic: this.nuclearKineticEnergy() },
      totalEnergy: point.totalEnergy,
      energyDrift: point.energyDrift,
      scf: {
        iteration: result.iteration,
        bestIteration: result.bestIteration,
        usedBestIteration: result.usedBestIteration,
        residual: result.residual,
        durationMs: result.durationMs,
        densityIntegral: result.density.reduce((sum, value) => sum + value * this.spacing * this.spacing, 0),
        energyDelta: result.energyDelta,
        converged: result.converged,
        history: result.history,
      },
      trajectory: this.trajectory.map((entry) => ({ ...entry, positions: entry.positions.map((position) => [...position] as Vector2) })),
    }
  }

  private emptyComponents(): EnergyComponents {
    return { kinetic: 0, electronNuclear: 0, hartree: 0, exchange: 0, nuclear: 0, nuclearKinetic: 0 }
  }
}

function applyKinetic(field: Float64Array, n: number, spacing: number) {
  const result = new Float64Array(field.length)
  const scale = -0.5 / (12 * spacing * spacing)
  const value = (x: number, y: number) => x < 0 || y < 0 || x >= n || y >= n ? 0 : field[y * n + x]!
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const laplacian = -value(x + 2, y) + 16 * value(x + 1, y) - 30 * value(x, y) + 16 * value(x - 1, y) - value(x - 2, y)
        - value(x, y + 2) + 16 * value(x, y + 1) - 30 * value(x, y) + 16 * value(x, y - 1) - value(x, y - 2)
      result[y * n + x] = scale * laplacian
    }
  }
  return result
}

function innerProduct(a: Float64Array, b: Float64Array, spacing: number) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!
  return sum * spacing * spacing
}

function orthonormalize(fields: Float64Array[], spacing: number) {
  const result: Float64Array[] = []
  for (const source of fields) {
    const field = source.slice()
    for (const previous of result) {
      const overlap = innerProduct(previous, field, spacing)
      for (let i = 0; i < field.length; i += 1) field[i] = field[i]! - overlap * previous[i]!
    }
    const norm = Math.sqrt(Math.max(innerProduct(field, field, spacing), 1e-30))
    for (let i = 0; i < field.length; i += 1) field[i] = field[i]! / norm
    result.push(field)
  }
  return result
}

function updateOrbitals(orbitals: Float64Array[], residuals: Float64Array[], step: number, spacing: number) {
  const updated = orbitals.map((orbital, index) => {
    const next = orbital.slice()
    const residual = residuals[index]!
    for (let i = 0; i < next.length; i += 1) next[i] = next[i]! - step * residual[i]!
    return next
  })
  return orthonormalize(updated, spacing)
}

function fieldSetNorm(fields: Float64Array[], spacing: number) {
  if (fields.length === 0) return 0
  return Math.sqrt(fields.reduce((sum, field) => sum + innerProduct(field, field, spacing), 0) / fields.length)
}

function addFields(a: Float64Array, b: Float64Array) {
  const result = new Float64Array(a.length)
  for (let i = 0; i < result.length; i += 1) result[i] = a[i]! + b[i]!
  return result
}

function subtractFields(a: Float64Array, b: Float64Array) {
  const result = new Float64Array(a.length)
  for (let i = 0; i < result.length; i += 1) result[i] = a[i]! - b[i]!
  return result
}

function multiplyFields(a: Float64Array, b: Float64Array) {
  const result = new Float64Array(a.length)
  for (let i = 0; i < result.length; i += 1) result[i] = a[i]! * b[i]!
  return result
}

function pseudoRandom(x: number, y: number, orbital: number, seed: number) {
  let value = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(orbital + 1, 2246822519) ^ seed
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff - 0.5
}
