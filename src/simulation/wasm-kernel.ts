import initialize, { ReferenceCore, version } from './wasm/pkg/hf2d_engine'
import type { FieldConvolver } from './fft2d'
import type { SimulationConfig } from './types'

let initialized: Promise<unknown> | null = null

export async function loadWasmKernel() {
  initialized ??= initialize()
  await initialized
  return version()
}

export async function createWasmConvolver(config: SimulationConfig): Promise<FieldConvolver> {
  await loadWasmKernel()
  const spacing = 2 * config.domainRadius / config.gridSize
  const core = new ReferenceCore(config.gridSize, spacing, config.softening, config.referenceLength)
  return {
    convolve(field) {
      return Float64Array.from(core.convolve(field))
    },
    precondition(field, shift = 1) {
      return Float64Array.from(core.precondition(field, shift))
    },
  }
}
