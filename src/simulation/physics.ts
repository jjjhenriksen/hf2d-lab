import type { Nucleus, Vector2 } from './types'

export function logarithmicKernel(r2: number, epsilon: number, referenceLength = 1) {
  return -0.5 * Math.log((r2 + epsilon * epsilon) / (referenceLength * referenceLength))
}

export function pairEnergy(qA: number, qB: number, a: Vector2, b: Vector2, epsilon: number, referenceLength = 1) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return qA * qB * logarithmicKernel(dx * dx + dy * dy, epsilon, referenceLength)
}

export function pairForce(qA: number, qB: number, a: Vector2, b: Vector2, epsilon: number): Vector2 {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const scale = qA * qB / (dx * dx + dy * dy + epsilon * epsilon)
  return [scale * dx, scale * dy]
}

export function nuclearEnergy(nuclei: Nucleus[], epsilon: number, referenceLength = 1) {
  let energy = 0
  for (let a = 0; a < nuclei.length; a += 1) {
    for (let b = a + 1; b < nuclei.length; b += 1) {
      energy += pairEnergy(nuclei[a]!.charge, nuclei[b]!.charge, nuclei[a]!.position, nuclei[b]!.position, epsilon, referenceLength)
    }
  }
  return energy
}

export function nuclearForces(nuclei: Nucleus[], epsilon: number) {
  const forces = nuclei.map(() => [0, 0] as [number, number])
  for (let a = 0; a < nuclei.length; a += 1) {
    for (let b = a + 1; b < nuclei.length; b += 1) {
      const force = pairForce(nuclei[a]!.charge, nuclei[b]!.charge, nuclei[a]!.position, nuclei[b]!.position, epsilon)
      forces[a]![0] += force[0]
      forces[a]![1] += force[1]
      forces[b]![0] -= force[0]
      forces[b]![1] -= force[1]
    }
  }
  return forces
}

export function relativeError(actual: number, expected: number) {
  return Math.abs(actual - expected) / Math.max(1, Math.abs(actual), Math.abs(expected))
}
