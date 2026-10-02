import { strFromU8, unzipSync } from 'fflate'
import { validateConfig } from './schema'
import type { SimulationConfig } from './types'

export const MAX_SESSION_COMPRESSED_BYTES = 16 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_JSON_BYTES = 256 * 1024
const SESSION_ENTRIES = new Set([
  'manifest.json', 'config.json', 'checkpoint.json', 'density.f32', 'spin-density.f32',
  'orbitals-alpha.f32', 'orbitals-beta.f32', 'trajectory.csv', 'diagnostics.csv', 'preview.png',
])

export type SessionImportResponse = { config: SimulationConfig; error?: never } | { error: string; config?: never }

/** Runs in the import worker; the first ZIP pass inspects metadata without extracting any entry. */
export function readSessionArchive(bytes: Uint8Array): SimulationConfig {
  if (bytes.byteLength > MAX_SESSION_COMPRESSED_BYTES) throw new Error('Session ZIP exceeds the 16 MiB compressed limit. Choose a smaller bundle.')
  const entries = new Set<string>()
  let expandedBytes = 0
  unzipSync(bytes, { filter: (entry) => {
    if (entries.size >= SESSION_ENTRIES.size) throw new Error('Session ZIP contains too many entries (maximum 10).')
    if (!SESSION_ENTRIES.has(entry.name)) throw new Error(`Unexpected session entry: ${entry.name}. Choose an HF2D session bundle.`)
    if (entries.has(entry.name)) throw new Error(`Duplicate session entry: ${entry.name}.`)
    entries.add(entry.name)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > bytes.byteLength
      || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw new Error('Invalid session ZIP entry sizes.')
    if (entry.compression !== 0 && entry.compression !== 8) throw new Error('Unsupported session ZIP compression. Use stored or deflated entries.')
    if (entry.compression === 0 && entry.size !== entry.originalSize) throw new Error('Invalid stored session ZIP entry size.')
    expandedBytes += entry.originalSize
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('Session ZIP exceeds the 64 MiB expanded limit. Export a shorter session.')
    if ((entry.name === 'manifest.json' || entry.name === 'config.json') && entry.originalSize > MAX_JSON_BYTES) {
      throw new Error(`${entry.name} exceeds the 256 KiB JSON limit. Choose a smaller session configuration.`)
    }
    return false
  } })
  if (!entries.has('manifest.json') || !entries.has('config.json')) throw new Error('Session bundle is missing manifest.json or config.json.')
  // Numerical fields and trajectories are not needed to restore configuration, so never expand them.
  const archive = unzipSync(bytes, { filter: entry => entry.name === 'manifest.json' || entry.name === 'config.json' })
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as { schema?: string }
  if (manifest.schema !== 'hf2d-session/v1') throw new Error(`Unsupported session schema: ${manifest.schema ?? 'missing'}`)
  return validateConfig(JSON.parse(strFromU8(archive['config.json']!)))
}
