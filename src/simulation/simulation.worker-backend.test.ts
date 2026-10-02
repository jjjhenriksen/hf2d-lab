import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import type { SimulationConfig, WorkerRequest, WorkerResponse } from './types'

const deviceLoss = vi.hoisted(() => ({ resolve: (_info: { message: string; reason: string }) => {} }))

vi.mock('./wasm-kernel', () => ({
  loadWasmKernel: async () => 'backend-fixture',
  createWasmConvolver: async () => undefined,
}))
vi.mock('./webgpu', () => ({
  WebGpuDensityAccelerator: {
    create: async () => ({
      adapterLabel: 'Backend selection fixture',
      lost: new Promise(resolve => { deviceLoss.resolve = resolve }),
      createConvolver: async () => undefined,
    }),
  },
}))

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('worker backend reconfiguration', () => {
  it('applies wasm/webgpu/auto preferences with otherwise identical configuration', async () => {
    const messages: WorkerResponse[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
      postMessage: (message: WorkerResponse) => { messages.push(message) },
    }
    vi.stubGlobal('self', scope)
    await import('./simulation.worker')
    const config = clonePreset('h2')
    config.electrons = 0
    const configure = async (backend: SimulationConfig['backend'], expected: 'wasm' | 'webgpu', index: number) => {
      const id = `backend-${index}`
      scope.onmessage!({ data: { id, type: index === 0 ? 'initialize' : 'reconfigure', config: { ...config, backend } } } as MessageEvent<WorkerRequest>)
      await vi.waitFor(() => expect(messages.some(message => message.id === id && message.type === 'snapshot')).toBe(true))
      const response = messages.find(message => message.id === id && message.type === 'snapshot')!
      if (response.type !== 'snapshot') throw new Error('Expected worker snapshot')
      expect(response.snapshot.config.backend).toBe(backend)
      expect(response.snapshot.backend).toBe(expected)
      const capability = messages.find(message => message.id === id && message.type === 'capabilities')
      expect(capability?.type === 'capabilities' && capability.capabilities.selected).toBe(expected)
    }
    await configure('wasm', 'wasm', 0)
    await configure('webgpu', 'webgpu', 1)
    await configure('auto', 'wasm', 2)
    await configure('wasm', 'wasm', 3)
    expect(messages.some(message => message.type === 'error')).toBe(false)
  })
})


it('ignores a late WebGPU device-loss callback after switching to WASM', async () => {
  const messages: WorkerResponse[] = []
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
    postMessage: (message: WorkerResponse) => { messages.push(message) },
  }
  vi.stubGlobal('self', scope)
  await import('./simulation.worker')
  const config = clonePreset('h2')
  config.electrons = 0
  for (const backend of ['webgpu', 'wasm'] as const) {
    scope.onmessage!({ data: { id: backend, type: 'reconfigure', config: { ...config, backend } } } as MessageEvent<WorkerRequest>)
    await vi.waitFor(() => expect(messages.some(message => message.id === backend && message.type === 'snapshot')).toBe(true))
  }
  deviceLoss.resolve({ message: 'Superseded device', reason: 'destroyed' })
  await Promise.resolve()
  expect(messages.some(message => message.type === 'error')).toBe(false)
  scope.onmessage!({ data: { id: 'step', type: 'step' } } as MessageEvent<WorkerRequest>)
  await vi.waitFor(() => expect(messages.some(message => message.id === 'step' && message.type === 'snapshot')).toBe(true))
})
