import { describe, expect, it } from 'vitest'
import { OpenBoundaryConvolver } from './fft2d'
import { logarithmicKernel } from './physics'

describe('zero-padded FFT convolution', () => {
  it('matches direct open-boundary summation on a small grid', () => {
    const n = 4
    const spacing = 0.5
    const epsilon = 0.3
    const field = new Float64Array(n * n)
    field[1 * n + 1] = 0.7
    field[2 * n + 3] = -0.2
    const actual = new OpenBoundaryConvolver(n, spacing, epsilon, 1).convolve(field)
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        let expected = 0
        for (let sy = 0; sy < n; sy += 1) {
          for (let sx = 0; sx < n; sx += 1) {
            expected += field[sy * n + sx]! * logarithmicKernel(((x - sx) * spacing) ** 2 + ((y - sy) * spacing) ** 2, epsilon)
          }
        }
        expected *= spacing * spacing
        expect(actual[y * n + x]).toBeCloseTo(expected, 9)
      }
    }
  })
})
