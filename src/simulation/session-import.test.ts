import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clonePreset } from './presets'
import { importSession } from './session'

const manifest = strToU8(JSON.stringify({ schema: 'hf2d-session/v1' }))
const config = clonePreset('h2')
const bundle = (files: Record<string, Uint8Array>) => new File([zipSync(files) as Uint8Array<ArrayBuffer>], 'fixture.zip')

describe('bounded session imports', () => {
  it('rejects oversized files before reading them', async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(0))
    const file = { size: 16 * 1024 * 1024 + 1, arrayBuffer } as unknown as File
    await expect(importSession(file)).rejects.toThrow('16 MiB')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('rejects highly compressed oversized JSON before extracting it', async () => {
    const file = bundle({
      'manifest.json': manifest,
      'config.json': strToU8(JSON.stringify({ ...config, padding: 'x'.repeat(256 * 1024) })),
    })
    expect(file.size).toBeLessThan(4096)
    await expect(importSession(file)).rejects.toThrow('config.json exceeds the 256 KiB JSON limit')
  })

  it('rejects unexpected archive entries rather than expanding them', async () => {
    const file = bundle({ 'manifest.json': manifest, 'config.json': strToU8(JSON.stringify(config)), '../unexpected.txt': strToU8('unused') })
    await expect(importSession(file)).rejects.toThrow('Unexpected session entry')
  })
})

// This fixture executes the real archive parser behind the worker boundary; browser proof covers the native worker.
class ImportWorker {
  static instances: ImportWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn((bytes: Uint8Array) => {
    void import('./session-archive').then(({ readSessionArchive }) => {
      try { this.onmessage?.({ data: { config: readSessionArchive(bytes) } } as MessageEvent) }
      catch (error) { this.onmessage?.({ data: { error: error instanceof Error ? error.message : 'Invalid session archive.' } } as MessageEvent) }
    })
  })
  constructor() { ImportWorker.instances.push(this) }
}

beforeEach(() => { ImportWorker.instances = []; vi.stubGlobal('Worker', ImportWorker) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('uses and terminates a worker for ordinary session extraction', async () => {
  const file = bundle({ 'manifest.json': manifest, 'config.json': strToU8(JSON.stringify(config)) })
  await expect(importSession(file)).resolves.toEqual(config)
  expect(ImportWorker.instances).toHaveLength(1)
  expect(ImportWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
  expect(ImportWorker.instances[0]!.postMessage.mock.calls[0]![0]).toBeInstanceOf(Uint8Array)
})

it('terminates a stuck decompressor at its time budget', async () => {
  vi.useFakeTimers()
  class StuckWorker extends ImportWorker { postMessage = vi.fn() }
  vi.stubGlobal('Worker', StuckWorker)
  const pending = importSession(bundle({ 'manifest.json': manifest, 'config.json': strToU8(JSON.stringify(config)) }))
  const result = expect(pending).rejects.toThrow('Import took too long')
  await vi.advanceTimersByTimeAsync(10000)
  await result
  expect(ImportWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
})
