// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { set } from 'idb-keyval'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import { ReferenceHartreeFockEngine } from './reference-engine'
import type { WorkerRequest, WorkerResponse } from './types'
import { useSimulation } from './use-simulation'

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }))

class FixtureWorker {
  static instances: FixtureWorker[] = []
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn<(message: WorkerRequest) => void>()
  terminate = vi.fn()
  constructor() { FixtureWorker.instances.push(this) }
  emit(response: WorkerResponse) { this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>) }
}

beforeEach(() => {
  vi.resetAllMocks()
  FixtureWorker.instances = []
  vi.stubGlobal('Worker', FixtureWorker)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps solver state and controls usable after a failed autosave, and recovers on the next save', async () => {
  const config = clonePreset('h2')
  config.electrons = 0
  const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  vi.mocked(set).mockRejectedValueOnce(new DOMException('Full', 'QuotaExceededError')).mockResolvedValue(undefined)
  const { result } = renderHook(() => useSimulation(config))
  const worker = FixtureWorker.instances[0]!
  await act(async () => worker.emit({ id: 'request-1', type: 'snapshot', snapshot }))
  await waitFor(() => expect(result.current).toHaveProperty('persistenceWarning', 'Autosave unavailable. Export your session to keep a copy.'))
  expect(result.current.snapshot).toBe(snapshot)
  expect(result.current.error).toBeNull()
  act(() => result.current.run())
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 'request-2', type: 'run' })
  await act(async () => worker.emit({ id: 'request-2', type: 'snapshot', snapshot: { ...snapshot, step: 1 } }))
  await waitFor(() => expect(result.current).toHaveProperty('persistenceWarning', null))
  expect(unhandled).not.toHaveBeenCalled()
  window.removeEventListener('unhandledrejection', unhandled)
})

it('ignores late autosave completion after worker cleanup', async () => {
  const config = clonePreset('h2')
  config.electrons = 0
  const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
  let rejectSave!: (error: Error) => void
  vi.mocked(set).mockReturnValue(new Promise((_, reject) => { rejectSave = reject }))
  const { unmount } = renderHook(() => useSimulation(config))
  const worker = FixtureWorker.instances[0]!
  act(() => worker.emit({ id: 'request-1', type: 'snapshot', snapshot }))
  unmount()
  await act(async () => rejectSave(new Error('Late failure')))
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('ignores superseded snapshots, progress, capabilities and errors without autosaving them', async () => {
  const config = clonePreset('h2')
  config.electrons = 0
  const old = await new ReferenceHartreeFockEngine(config).initialize()
  const latest = { ...old, config: { ...config, domainRadius: 10 } }
  vi.mocked(set).mockResolvedValue(undefined)
  const { result } = renderHook(() => useSimulation(config))
  const worker = FixtureWorker.instances[0]!
  act(() => result.current.initialize(latest.config))
  const capabilities = { webgpu: false, wasm: false, selected: 'typescript' as const, reason: 'Latest configuration' }
  await act(async () => {
    worker.emit({ id: 'request-2', type: 'capabilities', capabilities })
    worker.emit({ id: 'request-2', type: 'snapshot', snapshot: latest })
  })
  await act(async () => {
    worker.emit({ id: 'request-1', type: 'snapshot', snapshot: old })
    worker.emit({ id: 'request-1', type: 'progress', iteration: 4, residual: 1, energy: 2, message: 'Old solve' })
    worker.emit({ id: 'request-1', type: 'capabilities', capabilities: { ...capabilities, reason: 'Old' } })
    worker.emit({ id: 'request-1', type: 'error', code: 'SOLVER_ERROR', message: 'Old failure', recoverable: true })
  })
  expect(result.current.snapshot).toBe(latest)
  expect(result.current.capabilities).toBe(capabilities)
  expect(result.current.progress).toBeNull()
  expect(result.current.error).toBeNull()
  expect(set).toHaveBeenCalledOnce()
})

it('continues accepting run output after a speed change but ignores it after pause', async () => {
  const config = clonePreset('h2')
  config.electrons = 0
  const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
  vi.mocked(set).mockResolvedValue(undefined)
  const { result } = renderHook(() => useSimulation(config))
  const worker = FixtureWorker.instances[0]!
  act(() => { result.current.run(); result.current.setSpeed(2) })
  await act(async () => worker.emit({ id: 'request-2', type: 'snapshot', snapshot: { ...snapshot, status: 'running', step: 1 } }))
  expect(result.current.snapshot?.status).toBe('running')
  act(() => result.current.pause())
  const paused = { ...snapshot, status: 'paused' as const, step: 1 }
  await act(async () => worker.emit({ id: 'request-4', type: 'snapshot', snapshot: paused }))
  await act(async () => worker.emit({ id: 'request-2', type: 'snapshot', snapshot: { ...snapshot, status: 'running', step: 2 } }))
  expect(result.current.snapshot).toBe(paused)
})

it('ignores an obsolete autosave failure after a new command', async () => {
  const config = clonePreset('h2')
  config.electrons = 0
  const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
  let rejectSave!: (error: Error) => void
  vi.mocked(set).mockReturnValue(new Promise((_, reject) => { rejectSave = reject }))
  const { result } = renderHook(() => useSimulation(config))
  const worker = FixtureWorker.instances[0]!
  act(() => worker.emit({ id: 'request-1', type: 'snapshot', snapshot }))
  act(() => result.current.initialize({ ...config, domainRadius: 10 }))
  await act(async () => rejectSave(new Error('Old write failure')))
  expect(result.current.persistenceWarning).toBeNull()
})
