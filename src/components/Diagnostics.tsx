import type { SimulationSnapshot } from '../simulation/types'

export function Diagnostics({ snapshot }: { snapshot: SimulationSnapshot | null }) {
  const trajectory = snapshot?.trajectory ?? []
  const history = snapshot?.scf.history ?? []
  const densityIntegral = snapshot?.scf.densityIntegral
  return (
    <section
      className="diagnostics"
      aria-label={densityIntegral === undefined ? 'Simulation diagnostics' : `Simulation diagnostics, density integral ${densityIntegral.toFixed(6)} electrons`}
    >
      <MiniPlot title="Total energy (au)" value={snapshot?.totalEnergy} points={trajectory.map((point) => point.totalEnergy)} color="#64cce9" xLabel="time (au)" />
      <MiniPlot title="SCF residual" value={snapshot?.scf.residual} points={history.map((point) => Math.log10(Math.max(point.residual, 1e-12)))} color="#65d1e7" xLabel="iteration" threshold={-6} />
      <div className="iteration-panel">
        <span>Iteration</span>
        <strong>{snapshot?.scf.iteration ?? 0}</strong>
        <small>/ {snapshot?.config.scf.maxIterations ?? 200} · {snapshot?.scf.durationMs !== undefined ? `${snapshot.scf.durationMs.toFixed(0)} ms` : '—'}</small>
        <div className="iteration-rule" />
        <span>SCF status</span>
        <div className="status-lights">{Array.from({ length: 8 }, (_, index) => <i key={index} className={snapshot?.scf.converged ? 'is-on' : index < 3 ? 'is-warm' : ''} />)}</div>
        <em className={snapshot?.scf.converged ? 'success-text' : ''}>{snapshot?.scf.converged ? 'converged' : 'solving'}</em>
      </div>
      <MiniPlot title="Energy drift (au)" value={snapshot?.energyDrift} points={trajectory.map((point) => point.energyDrift)} color="#e8a534" xLabel="time (au)" threshold={0} />
    </section>
  )
}

function MiniPlot({ title, value, points, color, xLabel, threshold }: { title: string; value?: number; points: number[]; color: string; xLabel: string; threshold?: number }) {
  const width = 360
  const height = 96
  const finite = points.filter(Number.isFinite)
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = Math.max(max - min, 1e-9)
  const path = finite.map((point, index) => {
    const x = 8 + index / Math.max(1, finite.length - 1) * (width - 16)
    const y = 8 + (1 - (point - min) / span) * (height - 20)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const thresholdY = threshold === undefined ? null : 8 + (1 - (threshold - min) / span) * (height - 20)
  return (
    <figure className="mini-plot">
      <figcaption><span>{title}</span><strong>{formatScientific(value)}</strong></figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} over ${xLabel}`} preserveAspectRatio="none">
        <line x1="8" x2={width - 8} y1="32" y2="32" />
        <line x1="8" x2={width - 8} y1="64" y2="64" />
        {thresholdY !== null && thresholdY >= 0 && thresholdY <= height && <line className="threshold" x1="8" x2={width - 8} y1={thresholdY} y2={thresholdY} />}
        {path && <path d={path} stroke={color} />}
      </svg>
      <small>{xLabel}</small>
    </figure>
  )
}

function formatScientific(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 0.01 && Math.abs(value) < 10000) return value.toFixed(6)
  return value.toExponential(2)
}
