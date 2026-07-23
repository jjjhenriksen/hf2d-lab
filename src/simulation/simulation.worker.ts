/// <reference lib="webworker" />
import { validateConfig } from './schema'
import { ReferenceHartreeFockEngine } from './reference-engine'
import { createWasmConvolver, loadWasmKernel } from './wasm-kernel'
import { WebGpuDensityAccelerator } from './webgpu'
import { pacingDelayMs, validateRunSpeed } from './pacing'
import type { ActiveBackend, BackendCapabilities, SimulationSnapshot, WorkerRequest, WorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

let engine: ReferenceHartreeFockEngine | null = null
let isRunning = false
let activeRequestId = 'worker'
let accelerator: WebGpuDensityAccelerator | null = null
let lastSnapshot: SimulationSnapshot | null = null
let wasmVersion: string | null = null
let runSpeed = 1

function send(message: WorkerResponse) {
  self.postMessage(message)
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
      accelerator ??= await WebGpuDensityAccelerator.create()
      webgpu = true
      accelerator.lost.then((info) => {
        accelerator = null
        isRunning = false
        send({ id: activeRequestId, type: 'error', code: 'WEBGPU_DEVICE_LOST', message: `WebGPU device lost: ${info.message || info.reason}`, recoverable: true })
      }).catch(() => undefined)
    } catch (error) {
      webgpuFailure = error instanceof Error ? error.message : 'WebGPU initialization failed.'
    }
  }
  const selected: ActiveBackend = preference === 'webgpu' && webgpu ? 'webgpu' : wasm ? 'wasm' : webgpu ? 'webgpu' : 'typescript'
  const reason = selected === 'webgpu'
    ? `WebGPU float32 density acceleration is active${wasm ? ` with Rust/WASM float64 kernel ${wasmVersion}.` : ' with the portable TypeScript kernel.'}`
    : selected === 'wasm'
      ? `Rust/WASM float64 reference kernel ${wasmVersion} is active.${webgpu && preference === 'auto' ? ' Select WebGPU hybrid to accelerate density evaluation.' : webgpuFailure ? ` ${webgpuFailure}` : ''}`
      : [wasmFailure, webgpuFailure, 'Portable TypeScript reference path is active.'].filter(Boolean).join(' ')
  return { webgpu, wasm, selected, reason }
}

async function solveInitial(request: Extract<WorkerRequest, { type: 'initialize' | 'reconfigure' | 'reset' }>) {
  const config = validateConfig(request.config)
  activeRequestId = request.id
  isRunning = false
  const caps = await capabilities(config.backend)
  send({ id: request.id, type: 'capabilities', capabilities: caps })
  const onProgress = (iteration: number, residual: number) => {
    if (iteration === 1 || iteration % 4 === 0) send({ id: request.id, type: 'progress', iteration, residual, message: 'Optimizing occupied orbitals' })
  }
  const convolver = caps.wasm ? await createWasmConvolver(config) : undefined
  const makeConvolver = caps.wasm
    ? (next: typeof config) => {
        // Reconfiguration creates a new engine below; this synchronous factory is not used for WASM grid changes.
        if (next.gridSize !== config.gridSize || next.softening !== config.softening || next.domainRadius !== config.domainRadius || next.referenceLength !== config.referenceLength) {
          throw new Error('WASM grid changes require a fresh engine initialization.')
        }
        return convolver!
      }
    : undefined
  engine = new ReferenceHartreeFockEngine(config, {
    convolver,
    makeConvolver,
    backend: caps.selected,
    densityAccelerator: caps.selected === 'webgpu' ? accelerator ?? undefined : undefined,
  })
  const snapshot = await engine.initialize(onProgress)
  sendSnapshot(request.id, snapshot)
}

async function stepOnce(id: string, running: boolean) {
  if (!engine) throw new Error('Initialize the solver before stepping.')
  const snapshot = await engine.step((iteration, residual) => {
    if (iteration === 1 || iteration % 4 === 0) send({ id, type: 'progress', iteration, residual, message: 'Converging the next Born–Oppenheimer state' })
  })
  const remainsRunning = running && isRunning
  sendSnapshot(id, { ...snapshot, status: remainsRunning ? 'running' : 'paused', message: remainsRunning ? 'Running converged dynamics' : running ? 'Paused at accepted checkpoint' : snapshot.message })
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
    const snapshot = await stepOnce(id, true)
    if (snapshot.time >= snapshot.config.dynamics.totalTime) isRunning = false
    const delay = pacingDelayMs(runSpeed, performance.now() - startedAt)
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  activeRequestId = request.id
  void (async () => {
    try {
      if (request.type === 'initialize' || request.type === 'reconfigure' || request.type === 'reset') await solveInitial(request)
      else if (request.type === 'step') await stepOnce(request.id, false)
      else if (request.type === 'run') await runLoop(request.id)
      else if (request.type === 'setSpeed') runSpeed = validateRunSpeed(request.stepsPerSecond)
      else if (request.type === 'pause') {
        isRunning = false
        if (lastSnapshot) sendSnapshot(request.id, { ...lastSnapshot, status: 'paused', message: 'Paused at accepted checkpoint' })
      }
      else if (request.type === 'cancel') {
        isRunning = false
        engine?.cancel()
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
    }
  })()
}
