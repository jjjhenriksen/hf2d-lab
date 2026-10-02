/// <reference lib="webworker" />
import { validateConfig } from './schema'
import { ReferenceHartreeFockEngine } from './reference-engine'
import { createWasmConvolver, loadWasmKernel } from './wasm-kernel'
import { WebGpuDensityAccelerator } from './webgpu'
import { pacingDelayMs, validateRunSpeed } from './pacing'
import type { ActiveBackend, BackendCapabilities, RunSpeed, SimulationSnapshot, WorkerRequest, WorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

let engine: ReferenceHartreeFockEngine | null = null
let isRunning = false
let activeRequestId = 'worker'
let accelerator: WebGpuDensityAccelerator | null = null
let lastSnapshot: SimulationSnapshot | null = null
let wasmVersion: string | null = null
let runSpeed: RunSpeed = 1
let generation = 0
let operationGeneration = 0
let operationCancelled = false
let operationActive = false
let solvingEngine: ReferenceHartreeFockEngine | null = null
let commandSerial = 0
let operations = Promise.resolve()
let wakeRun: (() => void) | null = null
let lastCapabilities: BackendCapabilities | null = null

function send(message: WorkerResponse) {
  if (operationGeneration === generation) self.postMessage(message)
}

async function capabilities(preference: 'auto' | 'wasm' | 'webgpu'): Promise<BackendCapabilities> {
  let webgpu = false
  let wasm = false
  let wasmFailure = ''
  let webgpuFailure = ''
  try {
    wasmVersion ??= await loadWasmKernel()
    wasm = true
  } catch (error) {
    wasmFailure = error instanceof Error ? `WASM unavailable: ${error.message}` : 'WASM initialization failed.'
  }
  if (preference !== 'wasm') {
    try {
      if (!accelerator) {
        const device = await WebGpuDensityAccelerator.create()
        accelerator = device
        device.lost.then((info) => {
          if (accelerator !== device) return
          accelerator = null
          if (lastCapabilities?.selected !== 'webgpu' || operationGeneration !== generation) return
          isRunning = false
          wakeRun?.()
          send({ id: activeRequestId, type: 'error', code: 'WEBGPU_DEVICE_LOST', message: `WebGPU device lost: ${info.message || info.reason}`, recoverable: true })
        }).catch(() => undefined)
      }
      webgpu = true
    } catch (error) {
      webgpuFailure = error instanceof Error ? error.message : 'WebGPU initialization failed.'
    }
  }
  const selected: ActiveBackend = preference === 'webgpu' && webgpu ? 'webgpu' : wasm ? 'wasm' : webgpu ? 'webgpu' : 'typescript'
  const webgpuAdapter = accelerator?.adapterLabel
  const reason = selected === 'webgpu'
    ? `WebGPU float32 density, kinetic, FFT convolution, and preconditioning are active with a 2e-5 SCF residual floor${webgpuAdapter ? ` on ${webgpuAdapter}` : ''}.${wasm ? ` Rust/WASM kernel ${wasmVersion} remains available for the portable reference path.` : ''}`
    : selected === 'wasm'
      ? `Rust/WASM float64 reference kernel ${wasmVersion} is active.${webgpu && preference === 'auto' ? ' Select WebGPU hybrid to accelerate the dominant SCF operators.' : webgpuFailure ? ` ${webgpuFailure}` : ''}`
      : [wasmFailure, webgpuFailure, 'Portable TypeScript reference path is active.'].filter(Boolean).join(' ')
  return { webgpu, wasm, selected, reason, webgpuAdapter }
}

async function solveOnEngine(target: ReferenceHartreeFockEngine, solve: (target: ReferenceHartreeFockEngine) => Promise<SimulationSnapshot>) {
  solvingEngine = target
  try { return await solve(target) }
  finally { solvingEngine = null }
}

async function solveInitial(request: Extract<WorkerRequest, { type: 'initialize' | 'reconfigure' }>) {
  const config = validateConfig(request.config)
  activeRequestId = request.id
  isRunning = false
  if (request.type === 'reconfigure' && engine && lastSnapshot && sameKernelConfig(lastSnapshot.config, config)) {
    if (lastCapabilities) send({ id: request.id, type: 'capabilities', capabilities: lastCapabilities })
    const snapshot = await solveOnEngine(engine, target => target.reconfigure(config, (iteration, residual, energy) => {
      if (iteration === 1 || iteration % 4 === 0) send({ id: request.id, type: 'progress', iteration, residual, energy, message: 'Applying parameters to the current state' })
    }))
    sendSnapshot(request.id, snapshot)
    return
  }
  const caps = await capabilities(config.backend)
  if (operationCancelled) throw new Error('Solver cancelled before initialization.')
  if (operationGeneration !== generation) return
  send({ id: request.id, type: 'capabilities', capabilities: caps })
  const onProgress = (iteration: number, residual: number, energy: number) => {
    if (iteration === 1 || iteration % 4 === 0) send({ id: request.id, type: 'progress', iteration, residual, energy, message: 'Optimizing occupied orbitals' })
  }
  const convolver = caps.selected === 'webgpu' && accelerator
    ? await accelerator.createConvolver(config)
    : caps.wasm
      ? await createWasmConvolver(config)
      : undefined
  const makeConvolver = convolver
    ? (next: typeof config) => {
        // Reconfiguration creates a new engine below; this synchronous factory is not used for grid changes.
        if (next.gridSize !== config.gridSize || next.softening !== config.softening || next.domainRadius !== config.domainRadius || next.referenceLength !== config.referenceLength) {
          throw new Error('Grid changes require a fresh engine initialization.')
        }
        return convolver
      }
    : undefined
  if (operationCancelled) throw new Error('Solver cancelled before initialization.')
  if (operationGeneration !== generation) return
  engine = new ReferenceHartreeFockEngine(config, {
    convolver,
    makeConvolver,
    backend: caps.selected,
    densityAccelerator: caps.selected === 'webgpu' ? accelerator ?? undefined : undefined,
  })
  lastCapabilities = caps
  const snapshot = await solveOnEngine(engine, target => target.initialize(onProgress))
  sendSnapshot(request.id, snapshot)
}

function sameKernelConfig(previous: SimulationSnapshot['config'], next: SimulationSnapshot['config']) {
  return previous.backend === next.backend
    && previous.gridSize === next.gridSize
    && previous.domainRadius === next.domainRadius
    && previous.softening === next.softening
    && previous.referenceLength === next.referenceLength
}

function resetToCheckpoint(id: string) {
  if (!engine) throw new Error('Initialize the solver before resetting.')
  isRunning = false
  sendSnapshot(id, engine.reset())
}

function setResetBaseline(id: string) {
  if (!engine) throw new Error('Initialize the solver before setting a reset baseline.')
  sendSnapshot(id, engine.setResetBaseline())
}

async function stepOnce(id: string, running: boolean) {
  if (!engine) throw new Error('Initialize the solver before stepping.')
  const snapshot = await solveOnEngine(engine, target => target.step((iteration, residual, energy) => {
    if (iteration === 1 || iteration % 4 === 0) send({ id, type: 'progress', iteration, residual, energy, message: 'Converging the next Born–Oppenheimer state' })
  }))
  const reachedEnd = running && snapshot.time >= snapshot.config.dynamics.totalTime
  if (reachedEnd) isRunning = false
  const remainsRunning = running && isRunning
  sendSnapshot(id, { ...snapshot, status: remainsRunning ? 'running' : 'paused', message: remainsRunning ? 'Running converged dynamics' : reachedEnd ? 'Reached requested simulation time.' : running ? 'Paused at accepted checkpoint' : snapshot.message })
  return snapshot
}

function sendSnapshot(id: string, snapshot: SimulationSnapshot) {
  lastSnapshot = snapshot
  send({ id, type: 'snapshot', snapshot })
}

async function runLoop(id: string) {
  if (isRunning) return
  isRunning = true
  while (isRunning && engine) {
    const startedAt = performance.now()
    await stepOnce(id, true)
    if (!isRunning) break
    const delay = pacingDelayMs(runSpeed, performance.now() - startedAt)
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        if (wakeRun === finish) wakeRun = null
        resolve()
      }
      const timer = setTimeout(finish, delay)
      wakeRun = finish
    })
  }
}

// Only this queue may mutate the engine. Stop signals are handled on arrival so
// a long run or pacing delay cannot prevent queued commands from taking effect.
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'setSpeed') {
    try { runSpeed = validateRunSpeed(request.stepsPerSecond) }
    catch (error) {
      self.postMessage({ id: request.id, type: 'error', code: 'SOLVER_ERROR', message: error instanceof Error ? error.message : 'Invalid run speed.', recoverable: true } satisfies WorkerResponse)
    }
    return
  }
  const serial = ++commandSerial
  if (request.type === 'initialize' || request.type === 'reconfigure' || request.type === 'reset' || request.type === 'cancel') generation++
  const requestedGeneration = generation
  isRunning = false
  wakeRun?.()
  if (request.type === 'cancel' && operationActive) {
    operationCancelled = true
    solvingEngine?.cancel()
  }
  operations = operations.then(async () => {
    // Discard commands queued for a configuration that the user replaced.
    if (requestedGeneration !== generation || (request.type === 'run' && serial !== commandSerial)) return
    activeRequestId = request.id
    operationGeneration = requestedGeneration
    operationCancelled = false
    operationActive = true
    try {
      if (request.type === 'initialize' || request.type === 'reconfigure') await solveInitial(request)
      else {
        if (lastCapabilities) send({ id: request.id, type: 'capabilities', capabilities: lastCapabilities })
        if (request.type === 'reset') resetToCheckpoint(request.id)
        else if (request.type === 'setBaseline') setResetBaseline(request.id)
        else if (request.type === 'step') await stepOnce(request.id, false)
        else if (request.type === 'run') await runLoop(request.id)
        else if (request.type === 'pause' || request.type === 'cancel') {
          if (lastSnapshot) {
            const retainSolverMessage = lastSnapshot.status === 'failed' || (request.type === 'cancel' && lastSnapshot.scf.stoppedEarly)
            sendSnapshot(request.id, {
              ...lastSnapshot,
              status: lastSnapshot.status === 'failed' ? 'failed' : 'paused',
              message: retainSolverMessage ? lastSnapshot.message : 'Paused at accepted checkpoint',
            })
          }
          else if (request.type === 'cancel') throw new Error('Solver cancelled before a checkpoint was available.')
        }
      }
    } catch (error) {
      isRunning = false
      send({
        id: request.id,
        type: 'error',
        code: error instanceof Error && error.message.includes('cancelled') ? 'CANCELLED' : 'SOLVER_ERROR',
        message: error instanceof Error ? error.message : 'Unknown worker failure.',
        recoverable: true,
      })
    } finally {
      operationActive = false
    }
  })
}
