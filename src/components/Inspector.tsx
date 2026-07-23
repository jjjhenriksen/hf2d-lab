import { ChevronDown, Download, FileUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BackendCapabilities, Nucleus, SimulationConfig, SimulationSnapshot } from '../simulation/types'

interface InspectorProps {
  config: SimulationConfig
  snapshot: SimulationSnapshot | null
  capabilities: BackendCapabilities | null
  editable: boolean
  canEditDynamics: boolean
  selectedNucleusId: string | null
  showSpin: boolean
  runSpeed: number
  onShowSpinChange: (show: boolean) => void
  onRunSpeedChange: (stepsPerSecond: number) => void
  onConfigChange: (config: SimulationConfig) => void
  onSelectNucleus: (id: string | null) => void
  onExport: () => void
  onImport: (file: File) => void
}

export function Inspector(props: InspectorProps) {
  const { config, snapshot, capabilities, editable, canEditDynamics, selectedNucleusId, showSpin, runSpeed, onShowSpinChange, onRunSpeedChange, onConfigChange, onSelectNucleus, onExport, onImport } = props
  const fileRef = useRef<HTMLInputElement>(null)
  const [advanced, setAdvanced] = useState(false)
  const selected = config.nuclei.find((nucleus) => nucleus.id === selectedNucleusId) ?? null
  const update = (recipe: (draft: SimulationConfig) => void) => {
    const next = structuredClone(config)
    recipe(next)
    next.presetId = editable ? 'custom' : next.presetId
    onConfigChange(next)
  }

  return (
    <aside className="inspector" aria-label="Simulation inspector">
      <InspectorGroup title="System">
        <ReadoutRow label="Nuclei" value={String(config.nuclei.length)} />
        <NumberField label="Electrons" value={config.electrons} min={1} max={24} step={1} disabled={!editable} onCommit={(value) => update((draft) => { draft.electrons = Math.round(value) })} />
        <ReadoutRow label="Charge" value={(config.nuclei.reduce((sum, nucleus) => sum + nucleus.charge, 0) - config.electrons).toFixed(3)} unit="au" />
        {editable && (
          <div className="inline-actions">
            <button onClick={() => update((draft) => {
              const id = `n-${Date.now().toString(36)}`
              draft.nuclei.push({ id, label: 'H', charge: 1, mass: 1836, position: [0, 0], velocity: [0, 0] })
              onSelectNucleus(id)
            })} disabled={config.nuclei.length >= 16}><Plus aria-hidden="true" /> Add nucleus</button>
            <button className="danger-action" disabled={!selected || config.nuclei.length <= 1} onClick={() => update((draft) => {
              draft.nuclei = draft.nuclei.filter((nucleus) => nucleus.id !== selectedNucleusId)
              onSelectNucleus(null)
            })}><Trash2 aria-hidden="true" /> Delete</button>
          </div>
        )}
      </InspectorGroup>

      {selected && editable && <NucleusEditor nucleus={selected} onCommit={(field, value) => update((draft) => {
        const nucleus = draft.nuclei.find((item) => item.id === selected.id)!
        if (field === 'charge' || field === 'mass') nucleus[field] = value
        else if (field === 'vx') nucleus.velocity = [value, nucleus.velocity[1]]
        else if (field === 'vy') nucleus.velocity = [nucleus.velocity[0], value]
      })} />}

      <InspectorGroup title="Interaction">
        <NumberField label="Softening ε" value={config.softening} min={0.05} max={2} step={0.05} unit="a₀" disabled={!editable} onCommit={(value) => update((draft) => { draft.softening = value })} />
        <input className="range-control" type="range" aria-label="Softening epsilon" min="0.05" max="2" step="0.05" value={config.softening} disabled={!editable} onChange={(event) => update((draft) => { draft.softening = Number(event.target.value) })} />
        <ReadoutRow label="Potential" value="Logarithmic 2D" />
      </InspectorGroup>

      <InspectorGroup title="SCF">
        <NumberField label="SCF tolerance" value={config.scf.tolerance} min={1e-9} max={1e-2} step={1e-6} disabled={!editable} exponential onCommit={(value) => update((draft) => { draft.scf.tolerance = value })} />
        <SelectField label="Basis size" value={String(config.gridSize)} disabled={!editable} options={[['64', '64 × 64 grid'], ['128', '128 × 128 grid'], ['256', '256 × 256 experimental']]} onChange={(value) => update((draft) => { draft.gridSize = Number(value) as 64 | 128 | 256 })} />
        <NumberField label="Max iterations" value={config.scf.maxIterations} min={10} max={1000} step={10} disabled={!editable} onCommit={(value) => update((draft) => { draft.scf.maxIterations = Math.round(value) })} />
        <div className="convergence-row">
          <span>Convergence</span>
          <div className="convergence-lights" aria-label={snapshot?.scf.converged ? 'SCF converged' : 'SCF not converged'}>
            {Array.from({ length: 6 }, (_, index) => <i key={index} className={snapshot?.scf.converged ? 'is-on' : index < Math.min(5, Math.ceil((snapshot?.scf.iteration ?? 0) / 10)) ? 'is-warm' : ''} />)}
          </div>
          <strong className={snapshot?.scf.converged ? 'success-text' : ''}>{snapshot?.scf.converged ? 'converged' : 'pending'}</strong>
        </div>
      </InspectorGroup>

      <InspectorGroup title="Dynamics">
        <NumberField label="Time step Δt" value={config.dynamics.timeStep} min={1e-4} max={0.5} step={0.01} unit="au" disabled={!canEditDynamics} onCommit={(value) => update((draft) => { draft.dynamics.timeStep = value })} />
        <p className="control-note">Editable while paused. Changing Δt restarts this setup at t = 0.</p>
        <NumberField label="Damping γ" value={config.dynamics.damping} min={0} step={0.01} unit="au⁻¹" disabled={!canEditDynamics} onCommit={(value) => update((draft) => { draft.dynamics.damping = value })} />
        <p className="control-note">0 preserves molecular dynamics; higher values dissipate nuclear motion toward a relaxed structure.</p>
        <label className="field-row">
          <span>Iteration speed</span>
          <select
            value={String(runSpeed)}
            aria-label="Iteration speed in accepted steps per second"
            onChange={(event) => onRunSpeedChange(Number(event.target.value))}
          >
            <option value="0.25">0.25 steps/s</option>
            <option value="0.5">0.50 steps/s</option>
            <option value="1">1.00 steps/s</option>
            <option value="2">2.00 steps/s</option>
            <option value="4">4.00 steps/s</option>
          </select>
        </label>
        <p className="control-note">Paces accepted MD steps only; Δt and SCF accuracy stay fixed.</p>
        <ReadoutRow label="Integrator" value={config.dynamics.damping > 0 ? 'Damped Velocity Verlet' : 'Velocity Verlet'} />
        <NumberField label="Total time" value={config.dynamics.totalTime} min={0.01} max={100000} step={1} unit="au" disabled={!editable} onCommit={(value) => update((draft) => { draft.dynamics.totalTime = value })} />
        <ReadoutRow label="Boundary" value="None" />
      </InspectorGroup>

      <button className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
        <ChevronDown aria-hidden="true" className={advanced ? 'is-open' : ''} /> Advanced
      </button>
      {advanced && (
        <div className="advanced-panel">
          <SelectField label="Method" value={config.method} disabled={!editable} options={[["RHF", "RHF · closed shell"], ["UHF", "UHF · spin resolved"]]} onChange={(value) => update((draft) => {
            draft.method = value as 'RHF' | 'UHF'
            if (draft.method === 'RHF') {
              draft.electrons += draft.electrons % 2
              draft.multiplicity = 1
            }
          })} />
          <NumberField label="Multiplicity" value={config.multiplicity} min={1} max={25} step={1} disabled={!editable || config.method === 'RHF'} onCommit={(value) => update((draft) => { draft.multiplicity = Math.round(value) })} />
          <SelectField label="Backend" value={config.backend} disabled={!editable} options={[["auto", "Auto"], ["wasm", "Portable reference"], ["webgpu", "WebGPU hybrid"]]} onChange={(value) => update((draft) => { draft.backend = value as SimulationConfig['backend'] })} />
          <label className="toggle-row"><span>Spin density</span><input type="checkbox" checked={showSpin} onChange={(event) => onShowSpinChange(event.target.checked)} /></label>
          <p className="backend-note">{capabilities?.reason ?? 'Checking numerical backends…'}</p>
          <div className="file-actions">
            <button onClick={onExport}><Download aria-hidden="true" /> Export session</button>
            <button onClick={() => fileRef.current?.click()}><FileUp aria-hidden="true" /> Import session</button>
            <input ref={fileRef} className="sr-only" type="file" accept=".zip,.hf2d,application/zip" onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onImport(file)
              event.currentTarget.value = ''
            }} />
          </div>
          <p className="model-note">Model 2D universe · Hartree–Fock omits electron correlation.</p>
        </div>
      )}
    </aside>
  )
}

function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="inspector-group"><h2>{title}<ChevronDown aria-hidden="true" /></h2><div className="inspector-fields">{children}</div></section>
}

function ReadoutRow({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return <div className="field-row"><span>{label}</span><output>{value}</output>{unit && <small>{unit}</small>}</div>
}

interface NumberFieldProps {
  label: string; value: number; min: number; max?: number; step: number; disabled?: boolean; unit?: string; exponential?: boolean; onCommit: (value: number) => void
}

function NumberField({ label, value, min, max, step, disabled, unit, exponential, onCommit }: NumberFieldProps) {
  const formattedValue = exponential ? value.toExponential(1) : String(value)
  const [draft, setDraft] = useState(formattedValue)
  useEffect(() => setDraft(formattedValue), [formattedValue])
  const commit = () => {
    const numeric = Number(draft)
    if (Number.isFinite(numeric) && numeric >= min && (max === undefined || numeric <= max)) onCommit(numeric)
    else setDraft(formattedValue)
  }
  return (
    <label className="field-row"><span>{label}</span><input type="text" inputMode="decimal" value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />{unit && <small>{unit}</small>}</label>
  )
}

function SelectField({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="field-row"><span>{label}</span><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
}

function NucleusEditor({ nucleus, onCommit }: { nucleus: Nucleus; onCommit: (field: 'charge' | 'mass' | 'vx' | 'vy', value: number) => void }) {
  return (
    <InspectorGroup title="Selected nucleus">
      <NumberField label="Charge Z" value={nucleus.charge} min={0.1} max={12} step={0.1} onCommit={(value) => onCommit('charge', value)} />
      <NumberField label="Mass" value={nucleus.mass} min={0.1} max={100000} step={1} unit="mₑ" onCommit={(value) => onCommit('mass', value)} />
      <NumberField label="Velocity x" value={nucleus.velocity[0]} min={-10} max={10} step={0.001} onCommit={(value) => onCommit('vx', value)} />
      <NumberField label="Velocity y" value={nucleus.velocity[1]} min={-10} max={10} step={0.001} onCommit={(value) => onCommit('vy', value)} />
    </InspectorGroup>
  )
}
