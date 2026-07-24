import type { SimulationConfig } from './types'

export function sameSimulationConfig(left: SimulationConfig, right: SimulationConfig) {
  return JSON.stringify(left) === JSON.stringify(right)
}
