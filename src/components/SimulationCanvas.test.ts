import { describe, expect, it } from 'vitest'
import { plotBounds } from './SimulationCanvas'

describe('simulation canvas plot bounds', () => {
  it.each([
    [900, 600],
    [600, 900],
    [390, 480],
  ])('keeps equal x and y scales inside a %d x %d canvas', (width, height) => {
    const plot = plotBounds(width, height)

    expect(plot.right - plot.left).toBeCloseTo(plot.bottom - plot.top, 10)
    expect(plot.left).toBeGreaterThanOrEqual(0)
    expect(plot.top).toBeGreaterThanOrEqual(0)
    expect(plot.right).toBeLessThanOrEqual(width)
    expect(plot.bottom).toBeLessThanOrEqual(height)
  })
})
