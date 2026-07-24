import type { Nucleus, PresetId, SimulationConfig } from './types'

const nucleus = (
  id: string,
  position: readonly [number, number],
  velocity: readonly [number, number] = [0, 0],
): Nucleus => ({ id, label: 'H', charge: 1, mass: 1836, position, velocity })

const common = {
  schema: 'hf2d-config/v1' as const,
  gridSize: 64 as const,
  domainRadius: 7,
  softening: 0.5,
  referenceLength: 1,
  coupling: 1,
  scf: { tolerance: 1e-6, energyTolerance: 1e-8, maxIterations: 200, mixing: 0.16, allowUnconvergedDynamics: false },
  dynamics: { timeStep: 0.05, totalTime: 50, damping: 0, integrator: 'velocity-verlet' as const, boundary: 'none' as const },
  seed: 982451653,
  backend: 'auto' as const,
}

export const PRESETS: Record<Exclude<PresetId, 'custom'>, SimulationConfig> = {
  h2: {
    ...common,
    presetId: 'h2',
    title: 'H₂ analogue',
    description: 'A closed-shell two-center system displaced slightly from equilibrium to reveal bonding density and nuclear vibration.',
    method: 'RHF',
    electrons: 2,
    multiplicity: 1,
    nuclei: [nucleus('h-a', [-1.6, 0], [0.002, 0]), nucleus('h-b', [1.6, 0], [-0.002, 0])],
  },
  triatomic: {
    ...common,
    presetId: 'triatomic',
    title: 'Triatomic bend',
    description: 'An open-shell doublet whose spin density follows a bent three-center geometry.',
    method: 'UHF',
    electrons: 3,
    multiplicity: 2,
    nuclei: [nucleus('t-a', [-2.1, -0.6]), nucleus('t-b', [0, 1.25], [0, -0.004]), nucleus('t-c', [2.1, -0.6])],
  },
  collision: {
    ...common,
    presetId: 'collision',
    title: 'Four-center collision',
    description: 'Two neutral fragments approach along offset trajectories while the mean field reorganizes at every nuclear step.',
    method: 'UHF',
    electrons: 4,
    multiplicity: 1,
    nuclei: [
      nucleus('c-a', [-3.4, -1.1], [0.018, 0]),
      nucleus('c-b', [-3.1, 1.0], [0.018, 0]),
      nucleus('c-c', [3.1, -1.0], [-0.018, 0]),
      nucleus('c-d', [3.4, 1.1], [-0.018, 0]),
    ],
  },
}

export const PRESET_ORDER: Array<Exclude<PresetId, 'custom'>> = ['h2', 'triatomic', 'collision']

export function clonePreset(id: Exclude<PresetId, 'custom'>): SimulationConfig {
  return structuredClone(PRESETS[id])
}

export function cloneAsSandbox(config: SimulationConfig): SimulationConfig {
  return { ...structuredClone(config), presetId: 'custom', title: `${config.title} sandbox` }
}
