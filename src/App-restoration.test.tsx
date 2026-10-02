// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { get, set } from 'idb-keyval'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { cloneAsSandbox, clonePreset } from './simulation/presets'
import type { WorkerRequest } from './simulation/types'

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }))
// Canvas layout is not implemented by jsdom; the app, controls, hook, and storage path remain real.
vi.mock('./components/SimulationCanvas', () => ({ SimulationCanvas: () => <div /> }))

class FixtureWorker {
  static instances: FixtureWorker[] = []
  postMessage = vi.fn<(request: WorkerRequest) => void>()
  terminate = vi.fn()
  constructor() { FixtureWorker.instances.push(this) }
}
const restores: Array<(saved: unknown) => void> = []
const savedConfig = () => {
  const config = cloneAsSandbox(clonePreset('h2'))
  config.electrons = 0
  config.title = 'Fictional older saved session'
  return config
}
const restoreAll = async () => act(async () => restores.forEach(resolve => resolve({ config: savedConfig() })))
const commands = () => FixtureWorker.instances.flatMap(worker => worker.postMessage.mock.calls.map(([request]) => request))

beforeEach(() => {
  vi.resetAllMocks()
  restores.length = 0
  FixtureWorker.instances = []
  vi.mocked(get).mockImplementation(() => new Promise(resolve => restores.push(resolve)))
  vi.mocked(set).mockResolvedValue(undefined)
  vi.stubGlobal('Worker', FixtureWorker)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('startup restoration preserves newer intent', () => {
  it('does not replace a preset chosen before the read resolves', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Triatomic bend' }))
    await restoreAll()
    expect(screen.getByRole('textbox', { name: 'Electrons' }).getAttribute('value')).toBe('3')
    expect(commands().filter(request => request.type === 'reconfigure')).toHaveLength(1)
    expect(commands().at(-1)).toMatchObject({ type: 'reconfigure', config: { presetId: 'triatomic' } })
  })

  it('preserves a sandbox edit made before the read resolves', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open sandbox' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Electrons' }), { target: { value: '1' } })
    await restoreAll()
    expect(screen.getByRole('textbox', { name: 'Electrons' }).getAttribute('value')).toBe('1')
    expect(commands().filter(request => request.type === 'reconfigure')).toHaveLength(1)
  })

  it('ignores restoration after unmount', async () => {
    const { unmount } = render(<App />)
    unmount()
    await restoreAll()
    expect(commands()).toHaveLength(1)
  })

  it('restores once when untouched, including StrictMode cleanup and remount', async () => {
    render(<StrictMode><App /></StrictMode>)
    await restoreAll()
    expect(commands().filter(request => request.type === 'reconfigure')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Electrons' }).getAttribute('value')).toBe('0')
  })
})
