import { AlertTriangle, ChevronDown, Download, FileUp, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { gridSpacing, integrationLimits } from '../simulation/discretization'
import { fieldViewOptions, type FieldViewId } from '../simulation/field-views'
import type { BackendCapabilities, Nucleus, RunSpeed, ScfAcceleration, SimulationConfig, SimulationSnapshot } from '../simulation/types'

interface InspectorProps {
  config: SimulationConfig
  snapshot: SimulationSnapshot | null
  capabilities: BackendCapabilities | null
  editable: boolean
  canEditDynamics: boolean
  canEditScfPolicy: boolean
  selectedNucleusId: string | null
  fieldView: FieldViewId
  runSpeed: RunSpeed
  onFieldViewChange: (view: FieldViewId) => void
  onRunSpeedChange: (stepsPerSecond: RunSpeed) => void
  onConfigChange: (config: SimulationConfig) => void
  onSelectNucleus: (id: string | null) => void
  onExport: () => void
  onImport: (file: File) => void
}

export function Inspector(props: InspectorProps) {
  const { config, snapshot, capabilities, editable, canEditDynamics, canEditScfPolicy, selectedNucleusId, fieldView, runSpeed, onFieldViewChange, onRunSpeedChange, onConfigChange, onSelectNucleus, onExport, onImport } = props
  const fileRef = useRef<HTMLInputElement>(null)
  const [advanced, setAdvanced] = useState(false)
  const selected = config.nuclei.find((nucleus) => nucleus.id === selectedNucleusId) ?? null
  const [lowerLimit, upperLimit] = integrationLimits(config.domainRadius)
  const viewOptions = fieldViewOptions(config)
  const selectedFieldView = viewOptions.some(({ id }) => id === fieldView) ? fieldView : 'density'
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
        <NumberField label="Softening ε" value={config.softening} positive recommendedMin={0.05} recommendedMax={2} step={0.05} unit="a₀" disabled={!editable} onCommit={(value) => update((draft) => { draft.softening = value })} />
        <ReadoutRow label="Potential" value="Logarithmic 2D" />
      </InspectorGroup>

      <InspectorGroup title="Real-space grid">
        <SelectField label="Integration grid" value={String(config.gridSize)} disabled={!editable} options={[['64', '64 × 64 points'], ['128', '128 × 128 points'], ['256', '256 × 256 experimental']]} onChange={(value) => update((draft) => { draft.gridSize = Number(value) as 64 | 128 | 256 })} />
        <NumberField label="Domain half-width L" value={config.domainRadius} positive recommendedMin={2} recommendedMax={50} step={0.5} unit="a₀" disabled={!editable} onCommit={(value) => update((draft) => { draft.domainRadius = value })} />
        <ReadoutRow label="Integration limits" value={`[${lowerLimit.toFixed(2)}, ${upperLimit.toFixed(2)}]²`} unit="a₀" />
        <ReadoutRow label="Grid spacing Δx" value={gridSpacing(config).toPrecision(4)} unit="a₀" />
        <p className="control-note">Orbitals are represented directly at these real-space grid points; this model does not use a separate atom-centered basis-set family.</p>
      </InspectorGroup>

      <InspectorGroup title="View">
        <SelectField label="Field" value={selectedFieldView} options={viewOptions.map(({ id, label }) => [id, label])} onChange={(value) => onFieldViewChange(value as FieldViewId)} />
        <p className="control-note">Orbital views show signed amplitude; RHF lists paired spatial orbitals once, while UHF lists each occupied spin-orbital.</p>
      </InspectorGroup>

      <InspectorGroup title="SCF">
        <NumberField label="SCF tolerance" value={config.scf.tolerance} positive recommendedMin={1e-9} recommendedMax={1e-2} step={1e-6} disabled={!editable} exponential onCommit={(value) => update((draft) => { draft.scf.tolerance = value })} />
        <NumberField label="Max iterations" value={config.scf.maxIterations} min={1} recommendedMin={10} recommendedMax={1000} step={10} disabled={!editable} onCommit={(value) => update((draft) => { draft.scf.maxIterations = Math.round(value) })} />
        <label className="toggle-row"><span>Approximate dynamics</span><input type="checkbox" checked={config.scf.allowUnconvergedDynamics} disabled={!canEditScfPolicy} onChange={(event) => update((draft) => { draft.scf.allowUnconvergedDynamics = event.target.checked })} /></label>
        <p className="control-note">Off by default. When enabled, a failed solve continues from its lowest-energy finite iteration and remains marked unconverged.</p>
        <SelectField label="Acceleration" value={config.scf.acceleration} disabled={!editable} options={[['kinetic-preconditioner', 'Kinetic preconditioner'], ['none', 'None · residual descent']]} onChange={(value) => update((draft) => { draft.scf.acceleration = value as ScfAcceleration })} />
        <NumberField label="Residual mixing" value={config.scf.mixing} positive recommendedMin={0.005} recommendedMax={0.325} step={0.01} disabled={!editable} onCommit={(value) => update((draft) => { draft.scf.mixing = value })} />
        <NumberField label="Preconditioner shift" value={config.scf.preconditionerShift} positive recommendedMin={0.1} recommendedMax={10} step={0.05} disabled={!editable || config.scf.acceleration === 'none'} onCommit={(value) => update((draft) => { draft.scf.preconditionerShift = value })} />
        <p className="control-note">Residual descent applies no accelerator. The update step is twice the mixing coefficient, clamped to 0.01–0.65; the kinetic preconditioner also uses the positive spectral shift.</p>
        <div className="convergence-row">
          <span>Convergence</span>
          <div className="convergence-lights" aria-label={snapshot?.scf.converged ? 'SCF converged' : 'SCF not converged'}>
            {Array.from({ length: 6 }, (_, index) => <i key={index} className={snapshot?.scf.converged ? 'is-on' : index < Math.min(5, Math.ceil((snapshot?.scf.iteration ?? 0) / 10)) ? 'is-warm' : ''} />)}
          </div>
          <strong className={snapshot?.scf.converged ? 'success-text' : snapshot?.scf.usedBestIteration ? 'warning-text' : ''}>{snapshot?.scf.converged ? 'converged' : snapshot?.scf.usedBestIteration ? `best #${snapshot.scf.bestIteration}` : 'pending'}</strong>
        </div>
      </InspectorGroup>

      <InspectorGroup title="Dynamics">
        <NumberField label="Time step Δt" value={config.dynamics.timeStep} positive recommendedMin={1e-4} recommendedMax={0.5} step={0.01} unit="au" disabled={!canEditDynamics} onCommit={(value) => update((draft) => { draft.dynamics.timeStep = value })} />
        <p className="control-note">Editable while paused. Changing Δt restarts this setup at t = 0.</p>
        <NumberField label="Damping γ" value={config.dynamics.damping} min={0} step={0.01} unit="au⁻¹" disabled={!canEditDynamics} onCommit={(value) => update((draft) => { draft.dynamics.damping = value })} />
        <p className="control-note">0 preserves molecular dynamics; higher values dissipate nuclear motion toward a relaxed structure.</p>
        <RunSpeedField value={runSpeed} onCommit={onRunSpeedChange} />
        <ReadoutRow label="Integrator" value={config.dynamics.damping > 0 ? 'Damped Velocity Verlet' : 'Velocity Verlet'} />
        <NumberField label="Total time" value={config.dynamics.totalTime} positive recommendedMin={0.01} recommendedMax={100000} step={1} unit="au" disabled={!editable} onCommit={(value) => update((draft) => { draft.dynamics.totalTime = value })} />
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
          <NumberField label="Multiplicity" value={config.multiplicity} min={1} step={1} disabled={!editable || config.method === 'RHF'} onCommit={(value) => update((draft) => { draft.multiplicity = Math.round(value) })} />
          <SelectField label="Backend" value={config.backend} disabled={!editable} options={[["auto", "Auto"], ["wasm", "Portable reference"], ["webgpu", "WebGPU hybrid"]]} onChange={(value) => update((draft) => { draft.backend = value as SimulationConfig['backend'] })} />
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
  label: string; value: number; min?: number; max?: number; positive?: boolean; recommendedMin?: number; recommendedMax?: number; step: number; disabled?: boolean; unit?: string; exponential?: boolean; suggestions?: number[]; onCommit: (value: number) => void
}

function NumberField({ label, value, min, max, positive, recommendedMin, recommendedMax, step, disabled, unit, exponential, suggestions, onCommit }: NumberFieldProps) {
  const formattedValue = exponential ? value.toExponential(1) : String(value)
  const [draft, setDraft] = useState(formattedValue)
  const warningId = useId()
  const suggestionListId = useId()
  const outsideRecommendation = (recommendedMin !== undefined && value < recommendedMin) || (recommendedMax !== undefined && value > recommendedMax)
  useEffect(() => setDraft(formattedValue), [formattedValue])
  const commit = () => {
    const numeric = Number(draft)
    const withinHardBounds = (!positive || numeric > 0) && (min === undefined || numeric >= min) && (max === undefined || numeric <= max)
    if (Number.isFinite(numeric) && withinHardBounds) onCommit(numeric)
    else setDraft(formattedValue)
  }
  return (
    <>
      <label className="field-row"><span>{label}</span><input type="text" inputMode="decimal" value={draft} disabled={disabled} list={suggestions ? suggestionListId : undefined} aria-describedby={outsideRecommendation ? warningId : undefined} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />{unit && <small>{unit}</small>}</label>
      {suggestions && <datalist id={suggestionListId}>{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist>}
      {outsideRecommendation && <p id={warningId} className="field-warning" role="status"><AlertTriangle aria-hidden="true" /> Outside the recommended {recommendedMin}–{recommendedMax}{unit ? ` ${unit}` : ''} range; results may be unstable.</p>}
    </>
  )
}

function RunSpeedField({ value, onCommit }: { value: RunSpeed; onCommit: (value: RunSpeed) => void }) {
  const lastLimitedValue = useRef(value ?? 1)
  useEffect(() => {
    if (value !== null) lastLimitedValue.current = value
  }, [value])
  return (
    <>
      <NumberField label="Iteration speed" value={value ?? lastLimitedValue.current} positive step={0.25} unit="steps/s" disabled={value === null} suggestions={[0.25, 0.5, 1, 2, 4]} onCommit={onCommit} />
      <label className="toggle-row"><span>Unlimited speed</span><input type="checkbox" checked={value === null} onChange={(event) => onCommit(event.target.checked ? null : lastLimitedValue.current)} /></label>
      <p className="control-note">{value === null ? 'Starts each accepted step immediately; Pause remains responsive.' : 'Enter any positive rate; suggested values remain available. Δt and SCF accuracy stay fixed.'}</p>
    </>
  )
}

function SelectField({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="field-row"><span>{label}</span><select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
}

function NucleusEditor({ nucleus, onCommit }: { nucleus: Nucleus; onCommit: (field: 'charge' | 'mass' | 'vx' | 'vy', value: number) => void }) {
  return (
    <InspectorGroup title="Selected nucleus">
      <NumberField label="Charge Z" value={nucleus.charge} positive recommendedMin={0.1} recommendedMax={12} step={0.1} onCommit={(value) => onCommit('charge', value)} />
      <NumberField label="Mass" value={nucleus.mass} positive recommendedMin={0.1} recommendedMax={100000} step={1} unit="mₑ" onCommit={(value) => onCommit('mass', value)} />
      <NumberField label="Velocity x" value={nucleus.velocity[0]} recommendedMin={-10} recommendedMax={10} step={0.001} onCommit={(value) => onCommit('vx', value)} />
      <NumberField label="Velocity y" value={nucleus.velocity[1]} recommendedMin={-10} recommendedMax={10} step={0.001} onCommit={(value) => onCommit('vy', value)} />
    </InspectorGroup>
  )
}
