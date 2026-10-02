import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import type { ReferenceHartreeFockEngine } from './reference-engine'
import type { WorkerRequest, WorkerResponse } from './types'

vi.mock('./wasm-kernel', () => ({
  loadWasmKernel: vi.fn(async () => { throw new Error('Portable ordering fixture') }),
  createWasmConvolver: vi.fn(),
}))

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const messages: WorkerResponse[] = []
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
    postMessage: (message: WorkerResponse) => { messages.push(message) },
  }
  vi.stubGlobal('self', scope)
  const { ReferenceHartreeFockEngine: Engine } = await import('./reference-engine')
  const config = clonePreset('h2')
  config.backend = 'wasm'
  config.electrons = 0
  config.dynamics.timeStep = 0.1
  config.dynamics.totalTime = 1
  const send = (request: WorkerRequest) => scope.onmessage!({ data: request } as MessageEvent<WorkerRequest>)
  const snapshot = (id: string) => messages.find(message => message.id === id && message.type === 'snapshot')
  const waitSnapshot = async (id: string) => {
    await vi.waitFor(() => expect(snapshot(id)).toBeDefined(), { timeout: 5000 })
    const response = snapshot(id)!
    if (response.type !== 'snapshot') throw new Error('Expected snapshot')
    return response.snapshot
  }
  return { Engine, config, messages, send, snapshot, waitSnapshot }
}

it('serializes a slow old solve before reconfiguration and suppresses its late output', async () => {
  const f = await fixture()
  const gate = deferred()
  const original = f.Engine.prototype.initialize
  const initialize = vi.spyOn(f.Engine.prototype, 'initialize').mockImplementationOnce(async function (this: ReferenceHartreeFockEngine, ...args) {
    await gate.promise
    args[0]?.(4, 0.5, 2)
    return original.apply(this, args)
  })
  await import('./simulation.worker')
  f.send({ id: 'old', type: 'initialize', config: f.config })
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  f.send({ id: 'new', type: 'reconfigure', config: { ...f.config, gridSize: 64, domainRadius: 10 } })
  await vi.advanceTimersByTimeAsync(20)
  expect(initialize).toHaveBeenCalledOnce()
  expect(f.snapshot('new')).toBeUndefined()
  const boundary = f.messages.length
  gate.resolve()
  const latest = await f.waitSnapshot('new')
  expect(latest.config.gridSize).toBe(64)
  expect(latest.config.domainRadius).toBe(10)
  expect(f.messages.slice(boundary).some(message => message.id === 'old')).toBe(false)
  f.send({ id: 'step', type: 'step' })
  expect((await f.waitSnapshot('step')).config.domainRadius).toBe(10)
})

it('keeps queued steps ordered and lets reset restore the checkpoint after an in-flight step', async () => {
  const f = await fixture()
  await import('./simulation.worker')
  f.send({ id: 'initial', type: 'initialize', config: f.config })
  await f.waitSnapshot('initial')
  const gate = deferred()
  const original = f.Engine.prototype.step
  const step = vi.spyOn(f.Engine.prototype, 'step').mockImplementationOnce(async function (this: ReferenceHartreeFockEngine, ...args) {
    await gate.promise
    return original.apply(this, args)
  })
  f.send({ id: 'one', type: 'step' })
  await vi.waitFor(() => expect(step).toHaveBeenCalledOnce())
  f.send({ id: 'two', type: 'step' })
  await vi.advanceTimersByTimeAsync(20)
  expect(step).toHaveBeenCalledOnce()
  gate.resolve()
  expect((await f.waitSnapshot('two')).step).toBe(2)
  expect((await f.waitSnapshot('one')).step).toBe(1)

  const resetGate = deferred()
  step.mockImplementationOnce(async function (this: ReferenceHartreeFockEngine, ...args) {
    await resetGate.promise
    return original.apply(this, args)
  })
  f.send({ id: 'old-step', type: 'step' })
  await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(3))
  f.send({ id: 'reset', type: 'reset', config: f.config })
  expect(f.snapshot('reset')).toBeUndefined()
  resetGate.resolve()
  const reset = await f.waitSnapshot('reset')
  expect(reset.step).toBe(0)
  expect(reset.time).toBe(0)
  expect(f.snapshot('old-step')).toBeUndefined()
})

it('pauses after the in-flight accepted run step and wakes a long pacing delay', async () => {
  const f = await fixture()
  await import('./simulation.worker')
  f.send({ id: 'initial', type: 'initialize', config: f.config })
  await f.waitSnapshot('initial')
  const gate = deferred()
  const original = f.Engine.prototype.step
  const step = vi.spyOn(f.Engine.prototype, 'step').mockImplementationOnce(async function (this: ReferenceHartreeFockEngine, ...args) {
    await gate.promise
    return original.apply(this, args)
  })
  f.send({ id: 'run', type: 'run' })
  await vi.waitFor(() => expect(step).toHaveBeenCalledOnce())
  f.send({ id: 'pause', type: 'pause' })
  expect(f.snapshot('pause')).toBeUndefined()
  gate.resolve()
  const paused = await f.waitSnapshot('pause')
  expect(paused.step).toBe(1)
  expect(paused.status).toBe('paused')
  f.send({ id: 'slow', type: 'setSpeed', stepsPerSecond: 0.25 })
  f.send({ id: 'run-again', type: 'run' })
  await f.waitSnapshot('run-again')
  f.send({ id: 'pause-again', type: 'pause' })
  await f.waitSnapshot('pause-again')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(step).toHaveBeenCalledTimes(2)
})

it('cancels initialization while backend setup is pending, then permits a fresh solve', async () => {
  const f = await fixture()
  const { loadWasmKernel } = await import('./wasm-kernel')
  const gate = deferred()
  vi.mocked(loadWasmKernel).mockImplementationOnce(async () => { await gate.promise; throw new Error('Portable fixture') })
  const initialize = vi.spyOn(f.Engine.prototype, 'initialize')
  await import('./simulation.worker')
  f.send({ id: 'old', type: 'initialize', config: f.config })
  await vi.waitFor(() => expect(loadWasmKernel).toHaveBeenCalled())
  f.send({ id: 'cancel', type: 'cancel' })
  gate.resolve()
  await vi.waitFor(() => expect(f.messages.some(message => message.id === 'cancel' && message.type === 'error' && message.code === 'CANCELLED')).toBe(true))
  expect(initialize).not.toHaveBeenCalled()
  f.send({ id: 'fresh', type: 'reconfigure', config: f.config })
  expect((await f.waitSnapshot('fresh')).scf.converged).toBe(true)
})

it('suppresses an obsolete solve error and continues with the replacement', async () => {
  const f = await fixture()
  const gate = deferred()
  const initialize = vi.spyOn(f.Engine.prototype, 'initialize').mockImplementationOnce(async () => {
    await gate.promise
    throw new Error('Obsolete solve failed')
  })
  await import('./simulation.worker')
  f.send({ id: 'old', type: 'initialize', config: f.config })
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  f.send({ id: 'replacement', type: 'reconfigure', config: { ...f.config, domainRadius: 10 } })
  gate.resolve()
  expect((await f.waitSnapshot('replacement')).config.domainRadius).toBe(10)
  expect(f.messages.some(message => message.type === 'error')).toBe(false)
})

it('does not start a queued run after a later pause', async () => {
  const f = await fixture()
  const gate = deferred()
  const original = f.Engine.prototype.initialize
  const initialize = vi.spyOn(f.Engine.prototype, 'initialize').mockImplementationOnce(async function (this: ReferenceHartreeFockEngine, ...args) {
    await gate.promise
    return original.apply(this, args)
  })
  const step = vi.spyOn(f.Engine.prototype, 'step')
  await import('./simulation.worker')
  f.send({ id: 'initial', type: 'initialize', config: f.config })
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  f.send({ id: 'run', type: 'run' })
  f.send({ id: 'pause', type: 'pause' })
  gate.resolve()
  expect((await f.waitSnapshot('pause')).step).toBe(0)
  await vi.advanceTimersByTimeAsync(2000)
  expect(step).not.toHaveBeenCalled()
  expect(f.snapshot('run')).toBeUndefined()
})

it('leaves the previous accepted engine usable when cancelling replacement backend setup', async () => {
  const f = await fixture()
  f.config.electrons = 2
  await import('./simulation.worker')
  f.send({ id: 'initial', type: 'initialize', config: f.config })
  expect((await f.waitSnapshot('initial')).scf.converged).toBe(true)
  const { loadWasmKernel } = await import('./wasm-kernel')
  const gate = deferred()
  vi.mocked(loadWasmKernel).mockImplementationOnce(async () => { await gate.promise; throw new Error('Portable fixture') })
  f.send({ id: 'replacement', type: 'reconfigure', config: { ...f.config, domainRadius: 10 } })
  await vi.waitFor(() => expect(loadWasmKernel).toHaveBeenCalledTimes(2))
  f.send({ id: 'cancel', type: 'cancel' })
  gate.resolve()
  expect((await f.waitSnapshot('cancel')).config.domainRadius).toBe(7)
  f.send({ id: 'step', type: 'step' })
  const next = await f.waitSnapshot('step')
  expect(next.scf.converged).toBe(true)
  expect(next.scf.stoppedEarly).toBe(false)
  expect(next.step).toBe(1)
}, 15_000)
