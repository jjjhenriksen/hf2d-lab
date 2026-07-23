import { z } from 'zod'
import type { SimulationConfig } from './types'

const finite = z.number().finite()
const vector = z.tuple([finite, finite])

export const configSchema: z.ZodType<SimulationConfig> = z.object({
  schema: z.literal('hf2d-config/v1'),
  presetId: z.enum(['h2', 'triatomic', 'collision', 'custom']),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  method: z.enum(['RHF', 'UHF']),
  electrons: z.number().int().min(1).max(24),
  multiplicity: z.number().int().min(1).max(25),
  gridSize: z.union([z.literal(64), z.literal(128), z.literal(256)]),
  domainRadius: finite.min(4).max(40),
  softening: finite.min(0.05).max(2),
  referenceLength: finite.positive().max(20),
  coupling: finite.positive().max(10),
  nuclei: z.array(z.object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(12),
    charge: finite.min(0.1).max(12),
    mass: finite.positive().max(100000),
    position: vector,
    velocity: vector,
  })).min(1).max(16),
  scf: z.object({
    tolerance: finite.min(1e-9).max(1e-2),
    energyTolerance: finite.min(1e-11).max(1e-2),
    maxIterations: z.number().int().min(10).max(1000),
    mixing: finite.min(0.01).max(0.8),
  }),
  dynamics: z.object({
    timeStep: finite.min(1e-4).max(0.5),
    totalTime: finite.min(0.01).max(100000),
    damping: finite.nonnegative(),
    integrator: z.literal('velocity-verlet'),
    boundary: z.literal('none'),
  }),
  seed: z.number().int().min(0).max(0xffffffff),
  backend: z.enum(['auto', 'wasm', 'webgpu']),
}).superRefine((config, ctx) => {
  if (config.method === 'RHF' && (config.electrons % 2 !== 0 || config.multiplicity !== 1)) {
    ctx.addIssue({ code: 'custom', path: ['method'], message: 'RHF requires an even-electron singlet.' })
  }
  const unpaired = config.multiplicity - 1
  if ((config.electrons + unpaired) % 2 !== 0 || unpaired > config.electrons) {
    ctx.addIssue({ code: 'custom', path: ['multiplicity'], message: 'Multiplicity is incompatible with the electron count.' })
  }
  const margin = config.domainRadius * 0.86
  config.nuclei.forEach((nucleus, index) => {
    if (Math.abs(nucleus.position[0]) > margin || Math.abs(nucleus.position[1]) > margin) {
      ctx.addIssue({ code: 'custom', path: ['nuclei', index, 'position'], message: 'Nucleus is inside the orbital boundary buffer.' })
    }
  })
})

export function validateConfig(input: unknown): SimulationConfig {
  if (!input || typeof input !== 'object') return configSchema.parse(input)
  const candidate = structuredClone(input) as { dynamics?: { damping?: unknown } }
  if (candidate.dynamics && candidate.dynamics.damping === undefined) candidate.dynamics.damping = 0
  return configSchema.parse(candidate)
}
