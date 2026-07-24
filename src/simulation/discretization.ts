import type { SimulationConfig } from './types'

export function gridSpacing(config: Pick<SimulationConfig, 'domainRadius' | 'gridSize'>) {
  return 2 * config.domainRadius / config.gridSize
}

export function integrationLimits(domainRadius: number): readonly [number, number] {
  return [-domainRadius, domainRadius]
}
