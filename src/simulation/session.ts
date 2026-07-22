import { get, set } from 'idb-keyval'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { validateConfig } from './schema'
import type { SessionManifest, SimulationConfig, SimulationSnapshot } from './types'

const AUTOSAVE_KEY = 'hf2d-session-v1:last-stable'

export async function autosaveSnapshot(snapshot: SimulationSnapshot) {
  if (!snapshot.scf.converged) return
  await set(AUTOSAVE_KEY, serializableSnapshot(snapshot))
}

export async function restoreAutosave(): Promise<SimulationConfig | null> {
  const saved = await get(AUTOSAVE_KEY)
  if (!saved || typeof saved !== 'object') return null
  try {
    return validateConfig((saved as { config?: unknown }).config)
  } catch {
    return null
  }
}

export function exportSession(snapshot: SimulationSnapshot, preview: Blob | null) {
  const manifest: SessionManifest = {
    schema: 'hf2d-session/v1',
    createdAt: new Date().toISOString(),
    appVersion: '0.1.0',
    backend: snapshot.backend,
    precision: snapshot.precision,
    conventions: {
      units: 'dimensionless-2d-atomic-units',
      kernel: '-0.5 log((r^2 + epsilon^2) / r0^2)',
      dynamics: 'Born-Oppenheimer / velocity Verlet',
    },
  }
  const trajectoryHeader = 'step,time,total_energy,energy_drift,scf_residual,positions_json\n'
  const trajectoryRows = snapshot.trajectory.map((point) => [point.step, point.time, point.totalEnergy, point.energyDrift, point.residual, JSON.stringify(point.positions)].map(csvCell).join(',')).join('\n')
  const diagnosticsHeader = 'iteration,residual,electronic_energy\n'
  const diagnosticRows = snapshot.scf.history.map((entry) => `${entry.iteration},${entry.residual},${entry.energy}`).join('\n')
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'config.json': strToU8(JSON.stringify(snapshot.config, null, 2)),
    'checkpoint.json': strToU8(JSON.stringify(serializableSnapshot(snapshot), null, 2)),
    'density.f32': floatBytes(snapshot.density),
    'spin-density.f32': floatBytes(snapshot.spinDensity),
    'orbitals-alpha.f32': floatBytes(snapshot.orbitalAlpha ?? new Float32Array()),
    'orbitals-beta.f32': floatBytes(snapshot.orbitalBeta ?? new Float32Array()),
    'trajectory.csv': strToU8(trajectoryHeader + trajectoryRows),
    'diagnostics.csv': strToU8(diagnosticsHeader + diagnosticRows),
  }
  return preview?.arrayBuffer().then((buffer) => {
    files['preview.png'] = new Uint8Array(buffer)
    return new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  }) ?? Promise.resolve(new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }))
}

export async function importSession(file: File) {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifestBytes = archive['manifest.json']
  const configBytes = archive['config.json']
  if (!manifestBytes || !configBytes) throw new Error('Session bundle is missing manifest.json or config.json.')
  const manifest = JSON.parse(strFromU8(manifestBytes)) as { schema?: string }
  if (manifest.schema !== 'hf2d-session/v1') throw new Error(`Unsupported session schema: ${manifest.schema ?? 'missing'}`)
  return validateConfig(JSON.parse(strFromU8(configBytes)))
}

export function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

function serializableSnapshot(snapshot: SimulationSnapshot) {
  return {
    schema: snapshot.schema,
    status: snapshot.status,
    time: snapshot.time,
    step: snapshot.step,
    config: snapshot.config,
    nuclei: snapshot.nuclei,
    totalEnergy: snapshot.totalEnergy,
    energyDrift: snapshot.energyDrift,
    scf: snapshot.scf,
    trajectory: snapshot.trajectory,
    backend: snapshot.backend,
    precision: snapshot.precision,
  }
}

function floatBytes(values: Float32Array) {
  return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength))
}

function csvCell(value: unknown) {
  const text = String(value)
  return text.includes(',') || text.includes('"') ? `"${text.replaceAll('"', '""')}"` : text
}
