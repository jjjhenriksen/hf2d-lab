import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { clonePreset } from './presets'
import { ReferenceHartreeFockEngine } from './reference-engine'
import { exportSession, importSession } from './session'

describe('hf2d-session/v1 bundle', () => {
  it('exports restart data, orbitals, diagnostics, and a valid import configuration', async () => {
    const config = clonePreset('h2')
    config.scf.maxIterations = 10
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    const blob = await exportSession(snapshot, null)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const archive = unzipSync(bytes)
    expect(Object.keys(archive).sort()).toEqual([
      'checkpoint.json', 'config.json', 'density.f32', 'diagnostics.csv', 'manifest.json',
      'orbitals-alpha.f32', 'orbitals-beta.f32', 'spin-density.f32', 'trajectory.csv',
    ])
    const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as { schema: string }
    expect(manifest.schema).toBe('hf2d-session/v1')
    expect(archive['orbitals-alpha.f32']!.byteLength).toBeGreaterThan(0)

    const file = new File([bytes as Uint8Array<ArrayBuffer>], 'session.hf2d.zip', { type: 'application/zip' })
    const imported = await importSession(file)
    expect(imported).toEqual(config)
  }, 20000)
})
