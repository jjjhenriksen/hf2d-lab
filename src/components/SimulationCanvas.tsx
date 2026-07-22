import { useEffect, useMemo, useRef, useState } from 'react'
import type { Nucleus, SimulationConfig, SimulationSnapshot, Vector2 } from '../simulation/types'

interface SimulationCanvasProps {
  config: SimulationConfig
  snapshot: SimulationSnapshot | null
  selectedNucleusId: string | null
  editable: boolean
  showSpin: boolean
  onSelectNucleus: (id: string | null) => void
  onMoveNucleus: (id: string, position: Vector2) => void
}

export function SimulationCanvas({ config, snapshot, selectedNucleusId, editable, showSpin, onSelectNucleus, onMoveNucleus }: SimulationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const nuclei = snapshot?.nuclei ?? config.nuclei
  const field = useMemo(() => snapshot ? (showSpin ? snapshot.spinDensity : snapshot.density) : initialGuessDensity(config), [snapshot, showSpin, config])
  const emptyContour = useMemo(() => new Float32Array(config.gridSize ** 2), [config.gridSize])
  const contour = snapshot?.orbitalContours ?? emptyContour

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => drawScene(canvas, config, nuclei, field, contour, snapshot?.trajectory ?? [], selectedNucleusId, showSpin))
    observer.observe(canvas)
    drawScene(canvas, config, nuclei, field, contour, snapshot?.trajectory ?? [], selectedNucleusId, showSpin)
    return () => observer.disconnect()
  }, [config, nuclei, field, contour, snapshot?.trajectory, selectedNucleusId, showSpin])

  const positionFromEvent = (event: React.PointerEvent<HTMLCanvasElement>): Vector2 => {
    const rect = event.currentTarget.getBoundingClientRect()
    const plot = plotBounds(rect.width, rect.height)
    const px = Math.max(plot.left, Math.min(plot.right, event.clientX - rect.left))
    const py = Math.max(plot.top, Math.min(plot.bottom, event.clientY - rect.top))
    return [
      ((px - plot.left) / (plot.right - plot.left) * 2 - 1) * config.domainRadius,
      (1 - (py - plot.top) / (plot.bottom - plot.top) * 2) * config.domainRadius,
    ]
  }

  const hitNucleus = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const plot = plotBounds(rect.width, rect.height)
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    return nuclei.find((nucleus) => {
      const [x, y] = worldToCanvas(nucleus.position, config.domainRadius, plot)
      return Math.hypot(mx - x, my - y) <= 18
    })
  }

  return (
    <section className="canvas-region" aria-label="Two-dimensional simulation canvas">
      <canvas
        id="simulation-canvas"
        ref={canvasRef}
        tabIndex={0}
        aria-label="Electron density field with nuclei and trajectories. Select a nucleus to inspect it."
        onPointerDown={(event) => {
          const hit = hitNucleus(event)
          onSelectNucleus(hit?.id ?? null)
          if (hit && editable) {
            setDragging(hit.id)
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          if (!dragging || !editable) return
          drawScene(event.currentTarget, config, nuclei.map((nucleus) => nucleus.id === dragging ? { ...nucleus, position: positionFromEvent(event) } : nucleus), field, contour, snapshot?.trajectory ?? [], dragging, showSpin)
        }}
        onPointerUp={(event) => {
          if (dragging && editable) onMoveNucleus(dragging, positionFromEvent(event))
          setDragging(null)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      />
      <div className="canvas-legend" aria-label="Canvas legend">
        <span><i className={showSpin ? 'legend-spin' : 'legend-density'} />{showSpin ? 'spin density' : 'electron density'}</span>
        <span><i className="legend-nucleus" />nuclei</span>
        <span><i className="legend-trajectory" />trajectory</span>
      </div>
      {selectedNucleusId && <SelectedReadout nucleus={nuclei.find((item) => item.id === selectedNucleusId) ?? null} />}
    </section>
  )
}

function SelectedReadout({ nucleus }: { nucleus: Nucleus | null }) {
  if (!nucleus) return null
  return (
    <div className="selected-readout">
      <strong>Selected nucleus</strong>
      <span>x = {nucleus.position[0].toFixed(3)} a₀</span>
      <span>y = {nucleus.position[1].toFixed(3)} a₀</span>
      <span>vₓ = {nucleus.velocity[0].toFixed(4)} a₀/au</span>
      <span>vᵧ = {nucleus.velocity[1].toFixed(4)} a₀/au</span>
    </div>
  )
}

interface PlotBounds { left: number; top: number; right: number; bottom: number }

function plotBounds(width: number, height: number): PlotBounds {
  const padding = Math.max(42, Math.min(width, height) * 0.075)
  return { left: padding, top: 20, right: width - 20, bottom: height - padding }
}

function worldToCanvas(position: Vector2, radius: number, plot: PlotBounds): Vector2 {
  return [
    plot.left + ((position[0] / radius + 1) / 2) * (plot.right - plot.left),
    plot.bottom - ((position[1] / radius + 1) / 2) * (plot.bottom - plot.top),
  ]
}

function drawScene(canvas: HTMLCanvasElement, config: SimulationConfig, nuclei: Nucleus[], field: Float32Array, contour: Float32Array, trajectory: SimulationSnapshot['trajectory'], selected: string | null, showSpin: boolean) {
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(320, Math.round(rect.width))
  const height = Math.max(320, Math.round(rect.height))
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#061019'
  ctx.fillRect(0, 0, width, height)
  const plot = plotBounds(width, height)
  drawDensity(ctx, field, config.gridSize, plot, showSpin)
  drawContours(ctx, contour, config.gridSize, plot)
  drawAxes(ctx, config.domainRadius, plot)
  drawTrajectories(ctx, trajectory, config.domainRadius, plot, nuclei.length)
  for (const nucleus of nuclei) drawNucleus(ctx, nucleus, config.domainRadius, plot, nucleus.id === selected)
}

function drawDensity(ctx: CanvasRenderingContext2D, field: Float32Array, n: number, plot: PlotBounds, showSpin: boolean) {
  const offscreen = document.createElement('canvas')
  offscreen.width = n
  offscreen.height = n
  const imageCtx = offscreen.getContext('2d')!
  const image = imageCtx.createImageData(n, n)
  let max = 1e-12
  for (const value of field) max = Math.max(max, Math.abs(value))
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const sourceIndex = (n - 1 - y) * n + x
      const value = field[sourceIndex]! / max
      const magnitude = Math.min(1, Math.sqrt(Math.abs(value)))
      const target = 4 * (y * n + x)
      if (showSpin && value < 0) {
        image.data[target] = 156 * magnitude
        image.data[target + 1] = 54 * magnitude
        image.data[target + 2] = 58 * magnitude
      } else {
        image.data[target] = (showSpin ? 225 : 22) * magnitude
        image.data[target + 1] = (showSpin ? 160 : 174) * magnitude
        image.data[target + 2] = (showSpin ? 51 : 228) * magnitude
      }
      image.data[target + 3] = Math.min(225, 25 + 230 * magnitude)
    }
  }
  imageCtx.putImageData(image, 0, 0)
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(offscreen, plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top)
  ctx.restore()
}

function drawContours(ctx: CanvasRenderingContext2D, field: Float32Array, n: number, plot: PlotBounds) {
  let max = 0
  for (const value of field) max = Math.max(max, Math.abs(value))
  if (max < 1e-8) return
  ctx.save()
  ctx.lineWidth = 0.75
  const levels = [-0.6, -0.35, -0.16, 0.16, 0.35, 0.6]
  for (const normalizedLevel of levels) {
    const level = normalizedLevel * max
    ctx.strokeStyle = normalizedLevel < 0 ? 'rgba(234, 170, 68, .23)' : 'rgba(119, 215, 244, .28)'
    ctx.beginPath()
    for (let y = 0; y < n - 1; y += 1) {
      for (let x = 0; x < n - 1; x += 1) {
        const values = [field[y * n + x]!, field[y * n + x + 1]!, field[(y + 1) * n + x + 1]!, field[(y + 1) * n + x]!]
        const mask = values.reduce((sum, value, index) => sum | (value >= level ? 1 << index : 0), 0)
        if (mask === 0 || mask === 15) continue
        const px = plot.left + x / (n - 1) * (plot.right - plot.left)
        const py = plot.bottom - y / (n - 1) * (plot.bottom - plot.top)
        const cw = (plot.right - plot.left) / (n - 1)
        const ch = (plot.bottom - plot.top) / (n - 1)
        ctx.moveTo(px + cw * 0.5, py)
        ctx.lineTo(px + cw, py - ch * 0.5)
      }
    }
    ctx.stroke()
  }
  ctx.restore()
}

function drawAxes(ctx: CanvasRenderingContext2D, radius: number, plot: PlotBounds) {
  ctx.save()
  ctx.strokeStyle = 'rgba(195, 207, 209, .42)'
  ctx.fillStyle = 'rgba(228, 225, 213, .74)'
  ctx.lineWidth = 1
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top)
  const tick = Math.max(1, Math.round(radius / 3))
  for (let value = -Math.floor(radius / tick) * tick; value <= radius; value += tick) {
    const [x] = worldToCanvas([value, 0], radius, plot)
    const [, y] = worldToCanvas([0, value], radius, plot)
    ctx.beginPath(); ctx.moveTo(x, plot.bottom); ctx.lineTo(x, plot.bottom + 6); ctx.stroke()
    ctx.fillText(String(value), x - 6, plot.bottom + 20)
    ctx.beginPath(); ctx.moveTo(plot.left - 6, y); ctx.lineTo(plot.left, y); ctx.stroke()
    if (value !== 0) ctx.fillText(String(value), plot.left - 28, y + 4)
  }
  ctx.font = '14px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('x (a₀)', (plot.left + plot.right) / 2 - 18, plot.bottom + 38)
  ctx.save(); ctx.translate(plot.left - 43, (plot.top + plot.bottom) / 2 + 18); ctx.rotate(-Math.PI / 2); ctx.fillText('y (a₀)', 0, 0); ctx.restore()
  ctx.restore()
}

function drawTrajectories(ctx: CanvasRenderingContext2D, trajectory: SimulationSnapshot['trajectory'], radius: number, plot: PlotBounds, count: number) {
  ctx.save()
  ctx.strokeStyle = 'rgba(238, 166, 45, .65)'
  ctx.lineWidth = 1.2
  for (let nucleus = 0; nucleus < count; nucleus += 1) {
    ctx.beginPath()
    trajectory.forEach((point, index) => {
      const position = point.positions[nucleus]
      if (!position) return
      const [x, y] = worldToCanvas(position, radius, plot)
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  ctx.restore()
}

function drawNucleus(ctx: CanvasRenderingContext2D, nucleus: Nucleus, radius: number, plot: PlotBounds, selected: boolean) {
  const [x, y] = worldToCanvas(nucleus.position, radius, plot)
  ctx.save()
  if (selected) {
    ctx.strokeStyle = '#e9a52e'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.stroke()
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 2) {
      ctx.beginPath(); ctx.moveTo(x + Math.cos(angle) * 20, y + Math.sin(angle) * 20); ctx.lineTo(x + Math.cos(angle) * 26, y + Math.sin(angle) * 26); ctx.stroke()
    }
  }
  ctx.fillStyle = '#f6b547'
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

function initialGuessDensity(config: SimulationConfig) {
  const field = new Float32Array(config.gridSize ** 2)
  const spacing = 2 * config.domainRadius / config.gridSize
  for (let y = 0; y < config.gridSize; y += 1) {
    for (let x = 0; x < config.gridSize; x += 1) {
      const px = -config.domainRadius + (x + 0.5) * spacing
      const py = -config.domainRadius + (y + 0.5) * spacing
      field[y * config.gridSize + x] = config.nuclei.reduce((sum, nucleus) => sum + Math.exp(-0.6 * ((px - nucleus.position[0]) ** 2 + (py - nucleus.position[1]) ** 2)), 0)
    }
  }
  return field
}
