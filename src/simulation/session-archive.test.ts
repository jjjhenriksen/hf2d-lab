import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { clonePreset } from './presets'
import { readSessionArchive } from './session-archive'

const files = () => ({
  'manifest.json': strToU8(JSON.stringify({ schema: 'hf2d-session/v1' })),
  'config.json': strToU8(JSON.stringify(clonePreset('h2'))),
})
function editDirectory(bytes: Uint8Array, name: string, edit: (view: DataView, offset: number) => void) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const length = view.getUint16(offset + 28, true)
    if (new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + length)) === name) {
      edit(view, offset)
      return bytes
    }
  }
  throw new Error('Missing fixture directory entry')
}

describe('session ZIP metadata preflight', () => {
  it('rejects a huge declared expanded payload before allocation', () => {
    const bytes = zipSync({ ...files(), 'checkpoint.json': strToU8('{}') })
    editDirectory(bytes, 'checkpoint.json', (view, offset) => view.setUint32(offset + 24, 64 * 1024 * 1024 + 1, true))
    expect(() => readSessionArchive(bytes)).toThrow('64 MiB expanded limit')
  })

  it('rejects duplicate names in the directory', () => {
    const bytes = zipSync({ ...files(), 'config.jsOn': strToU8('{}') })
    editDirectory(bytes, 'config.jsOn', (view, offset) => view.setUint8(offset + 46 + 9, 'o'.charCodeAt(0)))
    expect(() => readSessionArchive(bytes)).toThrow('Duplicate session entry: config.json')
  })

  it('rejects too many entries before extraction', () => {
    const entries = { ...files(), 'checkpoint.json': strToU8('{}'), 'density.f32': new Uint8Array(),
      'spin-density.f32': new Uint8Array(), 'orbitals-alpha.f32': new Uint8Array(), 'orbitals-beta.f32': new Uint8Array(),
      'trajectory.csv': new Uint8Array(), 'diagnostics.csv': new Uint8Array(), 'preview.png': new Uint8Array(), 'extra': new Uint8Array() }
    expect(() => readSessionArchive(zipSync(entries))).toThrow('too many entries')
  })

  it('does not inflate unused numerical data, even if its compressed stream is corrupt', () => {
    const bytes = zipSync({ ...files(), 'density.f32': new Uint8Array(65536) })
    editDirectory(bytes, 'density.f32', (view, offset) => {
      const local = view.getUint32(offset + 42, true)
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      bytes.fill(255, start, start + view.getUint32(offset + 20, true))
    })
    expect(readSessionArchive(bytes)).toEqual(clonePreset('h2'))
  })
})
