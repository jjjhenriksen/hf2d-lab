import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import type { WorkerRequest, WorkerResponse } from './types'

vi.mock('./wasm-kernel', () => ({
  loadWasmKernel: async () => { throw new Error('WASM unavailable in portable worker fixture') },
  createWasmConvolver: vi.fn(),
}))

beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('worker run completion', () => {
  it.each([
    { totalTime: 0.1, steps: 1 },
    { totalTime: 0.3, steps: 3 },
    { totalTime: 0.05, steps: 1 },
  ])('publishes a stopped final snapshot at $totalTime after $steps steps', async ({ totalTime, steps }) => {
    const messages: WorkerResponse[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: (message: WorkerResponse) => { messages.push(message) },
    }
    vi.stubGlobal('self', scope)
    await import('./simulation.worker')
    const send = (request: WorkerRequest) => scope.onmessage!({ data: request } as MessageEvent<WorkerRequest>)
    const config = clonePreset('h2')
    config.backend = 'wasm'
    config.electrons = 0
    config.dynamics.timeStep = 0.1
    config.dynamics.totalTime = totalTime
    send({ id: 'initialize', type: 'initialize', config })
    await vi.waitFor(() => expect(messages.some(message => message.id === 'initialize' && message.type === 'snapshot')).toBe(true))
    send({ id: 'speed', type: 'setSpeed', stepsPerSecond: null })
    send({ id: 'run', type: 'run' })
    const runSnapshots = () => messages.filter(message => message.id === 'run' && message.type === 'snapshot')
    await vi.waitFor(() => expect(runSnapshots()).toHaveLength(steps))
    const snapshots = runSnapshots().map(message => {
      if (message.type !== 'snapshot') throw new Error('Expected worker snapshot')
      return message.snapshot
    })
    expect(snapshots.at(-1)!.time).toBeGreaterThanOrEqual(totalTime)
    expect(snapshots.at(-1)!.status).toBe('paused')
    expect(snapshots.at(-1)!.message).toBe('Reached requested simulation time.')
    expect(snapshots.slice(0, -1).every(snapshot => snapshot.status === 'running')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(runSnapshots()).toHaveLength(steps)
    expect(messages.some(message => message.type === 'error')).toBe(false)
  })
})
