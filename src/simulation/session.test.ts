import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { clonePreset } from './presets'
import { ReferenceHartreeFockEngine } from './reference-engine'
import { exportSession } from './session'
import { readSessionArchive } from './session-archive'

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
      'orbital-energies.csv', 'orbitals-alpha.f32', 'orbitals-beta.f32', 'spin-density.f32', 'trajectory.csv',
      'virtual-orbitals-alpha.f32', 'virtual-orbitals-beta.f32',
    ])
    const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as { schema: string }
    expect(manifest.schema).toBe('hf2d-session/v1')
    expect(archive['orbitals-alpha.f32']!.byteLength).toBeGreaterThan(0)

    const imported = readSessionArchive(bytes)
    expect(imported).toEqual(config)
  }, 20000)

  it.each(['RHF', 'UHF'] as const)('exports labeled occupied and virtual %s orbital results', async (method) => {
    const config = clonePreset('h2')
    config.electrons = 0
    config.method = method
    const baseline = await new ReferenceHartreeFockEngine(config).initialize()
    const alpha = new Float32Array([99, 0.25, -0.5, 99]).subarray(1, 3)
    const snapshot = {
      ...baseline,
      orbitalCounts: { occupiedAlpha: 1, occupiedBeta: method === 'RHF' ? 1 : 0, virtualAlpha: 1, virtualBeta: 1 },
      orbitalEnergiesAlpha: [-0.8, 0.2],
      orbitalEnergiesBeta: method === 'RHF' ? [-0.8, 0.2] : [0.3],
      virtualOrbitalAlpha: alpha,
      virtualOrbitalBeta: new Float32Array([0.75, -0.125]),
    }
    const bytes = new Uint8Array(await (await exportSession(snapshot, null)).arrayBuffer())
    const archive = unzipSync(bytes)
    expect(Array.from(new Float32Array(archive['virtual-orbitals-alpha.f32']!.buffer))).toEqual([0.25, -0.5])
    expect(Array.from(new Float32Array(archive['virtual-orbitals-beta.f32']!.buffer))).toEqual([0.75, -0.125])
    const checkpoint = JSON.parse(strFromU8(archive['checkpoint.json']!))
    expect(checkpoint.orbitalCounts).toEqual(snapshot.orbitalCounts)
    expect(checkpoint.orbitalEnergiesAlpha).toEqual(snapshot.orbitalEnergiesAlpha)
    expect(checkpoint.orbitalEnergiesBeta).toEqual(snapshot.orbitalEnergiesBeta)
    expect(strFromU8(archive['orbital-energies.csv']!)).toBe(
      'spin,index,kind,energy\nalpha,1,occupied,-0.8\nalpha,2,virtual,0.2\n'
      + (method === 'RHF' ? 'beta,1,occupied,-0.8\nbeta,2,virtual,0.2' : 'beta,1,virtual,0.3'),
    )
    expect(readSessionArchive(bytes)).toEqual(config)
  })

  it('exports empty optional orbital results without inventing energy levels', async () => {
    const config = clonePreset('h2')
    config.electrons = 0
    const snapshot = await new ReferenceHartreeFockEngine(config).initialize()
    delete snapshot.virtualOrbitalAlpha
    delete snapshot.virtualOrbitalBeta
    delete snapshot.orbitalEnergiesAlpha
    delete snapshot.orbitalEnergiesBeta
    const archive = unzipSync(new Uint8Array(await (await exportSession(snapshot, null)).arrayBuffer()))
    expect(archive['virtual-orbitals-alpha.f32']!.byteLength).toBe(0)
    expect(archive['virtual-orbitals-beta.f32']!.byteLength).toBe(0)
    expect(strFromU8(archive['orbital-energies.csv']!)).toBe('spin,index,kind,energy\n')
    const checkpoint = JSON.parse(strFromU8(archive['checkpoint.json']!))
    expect(checkpoint.orbitalEnergiesAlpha).toEqual([])
    expect(checkpoint.orbitalEnergiesBeta).toEqual([])
  })
})
