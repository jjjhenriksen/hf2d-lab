import { get, set } from 'idb-keyval'
import { strToU8, zipSync } from 'fflate'
import { validateConfig } from './schema'
import { MAX_SESSION_COMPRESSED_BYTES, type SessionImportResponse } from './session-archive'
import type { SessionManifest, SimulationConfig, SimulationSnapshot } from './types'

const AUTOSAVE_KEY = 'hf2d-session-v1:last-stable'

export async function autosaveSnapshot(snapshot: SimulationSnapshot): Promise<string | null> {
  if (!snapshot.scf.converged) return null
  try {
    await set(AUTOSAVE_KEY, serializableSnapshot(snapshot))
    return null
  } catch {
    return 'Autosave unavailable. Export your session to keep a copy.'
  }
}

export async function restoreAutosave(): Promise<{ config: SimulationConfig | null; warning: string | null }> {
  let saved: unknown
  try {
    saved = await get(AUTOSAVE_KEY)
  } catch {
    return { config: null, warning: 'Saved session unavailable. You can continue working and export your session.' }
  }
  if (!saved || typeof saved !== 'object') return { config: null, warning: null }
  try {
    return { config: validateConfig((saved as { config?: unknown }).config), warning: null }
  } catch {
    return { config: null, warning: null }
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

export async function importSession(file: File): Promise<SimulationConfig> {
  if (file.size > MAX_SESSION_COMPRESSED_BYTES) throw new Error('Session ZIP exceeds the 16 MiB compressed limit. Choose a smaller bundle.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const worker = new Worker(new URL('./session-import.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (config: SimulationConfig | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.terminate()
      if (config) resolve(config)
      else reject(new Error(error ?? 'Unable to import session ZIP.'))
    }
    const timeout = setTimeout(() => finish(null, 'Import took too long. Choose a smaller session ZIP.'), 10000)
    worker.onmessage = (event: MessageEvent<SessionImportResponse>) => {
      const result = event.data
      finish(result.config ?? null, result.error)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(null, 'Unable to read session ZIP. Choose a valid HF2D session bundle.')
    }
    try { worker.postMessage(bytes, [bytes.buffer]) }
    catch { finish(null, 'Unable to start session import. Try again.') }
  })
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
