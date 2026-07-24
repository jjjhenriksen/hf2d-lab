import { spinOccupations, type SimulationConfig, type SimulationSnapshot } from './types'

const ORBITAL_VIEW_PATTERN = /^orbital-(alpha|beta)-(\d+)$/

export type FieldViewId = 'density' | 'spin-density' | `orbital-alpha-${number}` | `orbital-beta-${number}`

export interface FieldViewOption {
  id: FieldViewId
  label: string
}

export interface ResolvedFieldView extends FieldViewOption {
  field: Float32Array
  contour: Float32Array
  signed: boolean
}

export function fieldViewOptions(config: SimulationConfig): FieldViewOption[] {
  const options: FieldViewOption[] = [
    { id: 'density', label: 'Electron density' },
    { id: 'spin-density', label: 'Spin density' },
  ]

  try {
    const occupations = spinOccupations(config.electrons, config.multiplicity, config.method)
    if (config.method === 'RHF') {
      for (let index = 0; index < occupations.alpha; index += 1) {
        options.push({ id: `orbital-alpha-${index}`, label: `Occupied orbital ${index + 1} · paired` })
      }
      return options
    }

    for (let index = 0; index < occupations.alpha; index += 1) {
      options.push({ id: `orbital-alpha-${index}`, label: `α spin-orbital ${index + 1}` })
    }
    for (let index = 0; index < occupations.beta; index += 1) {
      options.push({ id: `orbital-beta-${index}`, label: `β spin-orbital ${index + 1}` })
    }
  } catch {
    // Invalid in-progress sandbox configurations retain the two aggregate views.
  }

  return options
}

export function resolveFieldView(snapshot: SimulationSnapshot, requestedId: FieldViewId): ResolvedFieldView {
  const option = fieldViewOptions(snapshot.config).find(({ id }) => id === requestedId)
  if (!option) return densityView(snapshot)
  if (option.id === 'density') return densityView(snapshot)
  if (option.id === 'spin-density') {
    return { ...option, field: snapshot.spinDensity, contour: snapshot.spinDensity, signed: true }
  }

  const match = ORBITAL_VIEW_PATTERN.exec(option.id)
  if (!match) return densityView(snapshot)
  const flattened = match[1] === 'alpha' ? snapshot.orbitalAlpha : snapshot.orbitalBeta
  const field = flattened && orbitalField(flattened, snapshot.gridSize, Number(match[2]))
  if (!field) return densityView(snapshot)
  return { ...option, field, contour: field, signed: true }
}

export function orbitalField(flattened: Float32Array, gridSize: number, index: number): Float32Array | null {
  const points = gridSize ** 2
  const start = index * points
  const end = start + points
  if (!Number.isInteger(index) || index < 0 || end > flattened.length) return null
  return flattened.subarray(start, end)
}

function densityView(snapshot: SimulationSnapshot): ResolvedFieldView {
  return {
    id: 'density',
    label: 'Electron density',
    field: snapshot.density,
    contour: snapshot.orbitalContours,
    signed: false,
  }
}
