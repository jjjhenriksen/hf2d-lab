export type Vector2 = readonly [number, number]
export type HartreeFockMethod = 'RHF' | 'UHF'
export type BackendPreference = 'auto' | 'wasm' | 'webgpu'
export type ActiveBackend = 'wasm' | 'webgpu' | 'typescript'
export type RunSpeed = number | null
export type SimulationStatus = 'idle' | 'solving' | 'ready' | 'running' | 'paused' | 'failed'

export interface Nucleus {
  id: string
  label: string
  charge: number
  mass: number
  position: Vector2
  velocity: Vector2
}

export interface ScfOptions {
  tolerance: number
  energyTolerance: number
  maxIterations: number
  mixing: number
  allowUnconvergedDynamics: boolean
}

export interface DynamicsOptions {
  timeStep: number
  totalTime: number
  damping: number
  integrator: 'velocity-verlet'
  boundary: 'none'
}

export interface SimulationConfig {
  schema: 'hf2d-config/v1'
  presetId: PresetId
  title: string
  description: string
  method: HartreeFockMethod
  electrons: number
  multiplicity: number
  gridSize: 64 | 128 | 256
  domainRadius: number
  softening: number
  referenceLength: number
  coupling: number
  nuclei: Nucleus[]
  scf: ScfOptions
  dynamics: DynamicsOptions
  seed: number
  backend: BackendPreference
}

export type PresetId = 'h2' | 'triatomic' | 'collision' | 'custom'

export interface EnergyComponents {
  kinetic: number
  electronNuclear: number
  hartree: number
  exchange: number
  nuclear: number
  nuclearKinetic: number
}

export interface ScfDiagnostics {
  iteration: number
  bestIteration?: number
  usedBestIteration?: boolean
  residual: number
  energyDelta: number
  durationMs?: number
  densityIntegral?: number
  converged: boolean
  history: Array<{ iteration: number; residual: number; energy: number }>
}

export interface TrajectoryPoint {
  step: number
  time: number
  totalEnergy: number
  energyDrift: number
  residual: number
  positions: Vector2[]
}

export interface SimulationSnapshot {
  schema: 'hf2d-snapshot/v1'
  status: SimulationStatus
  message: string
  backend: ActiveBackend
  precision: 'float32' | 'float64'
  time: number
  step: number
  config: SimulationConfig
  nuclei: Nucleus[]
  density: Float32Array
  spinDensity: Float32Array
  orbitalContours: Float32Array
  orbitalAlpha?: Float32Array
  orbitalBeta?: Float32Array
  gridSize: number
  energies: EnergyComponents
  totalEnergy: number
  energyDrift: number
  scf: ScfDiagnostics
  trajectory: TrajectoryPoint[]
}

export interface BackendCapabilities {
  webgpu: boolean
  wasm: boolean
  selected: ActiveBackend
  reason: string
  webgpuAdapter?: string
}

export type WorkerRequest =
  | { id: string; type: 'initialize'; config: SimulationConfig }
  | { id: string; type: 'reconfigure'; config: SimulationConfig }
  | { id: string; type: 'step' }
  | { id: string; type: 'run' }
  | { id: string; type: 'setSpeed'; stepsPerSecond: RunSpeed }
  | { id: string; type: 'pause' }
  | { id: string; type: 'reset'; config: SimulationConfig }
  | { id: string; type: 'cancel' }

export type WorkerResponse =
  | { id: string; type: 'progress'; iteration: number; residual: number; message: string }
  | { id: string; type: 'snapshot'; snapshot: SimulationSnapshot }
  | { id: string; type: 'capabilities'; capabilities: BackendCapabilities }
  | { id: string; type: 'error'; code: string; message: string; recoverable: boolean }

export interface SessionManifest {
  schema: 'hf2d-session/v1'
  createdAt: string
  appVersion: string
  backend: ActiveBackend
  precision: 'float32' | 'float64'
  conventions: {
    units: 'dimensionless-2d-atomic-units'
    kernel: '-0.5 log((r^2 + epsilon^2) / r0^2)'
    dynamics: 'Born-Oppenheimer / velocity Verlet'
  }
}

export function spinOccupations(electrons: number, multiplicity: number, method: HartreeFockMethod) {
  if (method === 'RHF') {
    if (electrons % 2 !== 0 || multiplicity !== 1) {
      throw new Error('RHF requires an even electron count and singlet multiplicity.')
    }
    return { alpha: electrons / 2, beta: electrons / 2 }
  }
  const unpaired = multiplicity - 1
  const alpha = (electrons + unpaired) / 2
  const beta = electrons - alpha
  if (!Number.isInteger(alpha) || alpha < 0 || beta < 0) {
    throw new Error('Electron count and multiplicity produce invalid UHF occupations.')
  }
  return { alpha, beta }
}
