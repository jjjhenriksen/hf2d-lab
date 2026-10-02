import { get, set } from 'idb-keyval'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import { ReferenceHartreeFockEngine } from './reference-engine'
import { autosaveSnapshot, restoreAutosave } from './session'

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

describe('recoverable session persistence', () => {
  it('reports denied reads without rejecting startup', async () => {
    vi.mocked(get).mockRejectedValue(new DOMException('Private details', 'SecurityError'))
    await expect(restoreAutosave()).resolves.toEqual({
      config: null,
      warning: 'Saved session unavailable. You can continue working and export your session.',
    })
  })

  it('reports quota failures without rejecting a converged simulation', async () => {
    const config = clonePreset('h2')
    config.electrons = 0
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    vi.mocked(set).mockRejectedValue(new DOMException('Private details', 'QuotaExceededError'))
    await expect(autosaveSnapshot(snapshot)).resolves.toBe('Autosave unavailable. Export your session to keep a copy.')
    expect(snapshot.status).toBe('ready')
  })

  it('round-trips a valid saved configuration and ignores invalid saved data', async () => {
    const config = clonePreset('h2')
    vi.mocked(get).mockResolvedValueOnce({ config }).mockResolvedValueOnce({ config: {} }).mockResolvedValueOnce(undefined)
    await expect(restoreAutosave()).resolves.toEqual({ config, warning: null })
    await expect(restoreAutosave()).resolves.toEqual({ config: null, warning: null })
    await expect(restoreAutosave()).resolves.toEqual({ config: null, warning: null })
  })
})
