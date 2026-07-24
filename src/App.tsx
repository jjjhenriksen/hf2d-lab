import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { Diagnostics } from './components/Diagnostics'
import { Inspector } from './components/Inspector'
import { PresetRail } from './components/PresetRail'
import { SimulationCanvas } from './components/SimulationCanvas'
import { TopBar } from './components/TopBar'
import { sameSimulationConfig } from './simulation/config-state'
import { fieldViewOptions, type FieldViewId } from './simulation/field-views'
import { cloneAsSandbox, clonePreset } from './simulation/presets'
import { downloadBlob, exportSession, importSession, restoreAutosave } from './simulation/session'
import { validateConfig } from './simulation/schema'
import type { PresetId, RunSpeed, SimulationConfig, Vector2 } from './simulation/types'
import { useSimulation } from './simulation/use-simulation'

export function App() {
  const initialRef = useRef(clonePreset('h2'))
  const [config, setConfig] = useState<SimulationConfig>(initialRef.current)
  const [appliedConfig, setAppliedConfig] = useState<SimulationConfig>(initialRef.current)
  const [mode, setMode] = useState<'guided' | 'sandbox'>('guided')
  const [selectedPreset, setSelectedPreset] = useState<PresetId>('h2')
  const [selectedNucleusId, setSelectedNucleusId] = useState<string | null>('h-a')
  const [fieldView, setFieldView] = useState<FieldViewId>('density')
  const [runSpeed, setRunSpeed] = useState<RunSpeed>(1)
  const [validationError, setValidationError] = useState<string | null>(null)
  const simulation = useSimulation(initialRef.current)
  const { pause, run, step } = simulation
  const isRunning = simulation.snapshot?.status === 'running'
  const isBusy = Boolean(simulation.progress)
  const needsScf = useMemo(() => !sameSimulationConfig(config, appliedConfig), [config, appliedConfig])
  const displayedSnapshot = needsScf ? null : simulation.snapshot
  const canRun = Boolean(
    displayedSnapshot?.scf.converged
    || (appliedConfig.scf.allowUnconvergedDynamics && displayedSnapshot?.scf.usedBestIteration),
  ) && !simulation.error && !validationError
  const canSolve = !isRunning && !isBusy && !validationError
  const activeFieldView = fieldViewOptions(config).some(({ id }) => id === fieldView) ? fieldView : 'density'

  const applyConfig = useCallback((next: SimulationConfig) => {
    try {
      const validated = validateConfig(next)
      setConfig(validated)
      setValidationError(null)
    } catch (error) {
      setConfig(next)
      setValidationError(error instanceof Error ? error.message : 'Invalid configuration.')
    }
  }, [])

  const solveScf = useCallback(() => {
    try {
      const validated = validateConfig(config)
      setConfig(validated)
      setAppliedConfig(validated)
      setValidationError(null)
      simulation.initialize(validated)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Invalid configuration.')
    }
  }, [config, simulation.initialize])

  const resetAppliedConfig = useCallback(() => {
    setConfig(appliedConfig)
    setValidationError(null)
    simulation.reset(appliedConfig)
  }, [appliedConfig, simulation.reset])

  const handleRunSpeedChange = useCallback((stepsPerSecond: RunSpeed) => {
    setRunSpeed(stepsPerSecond)
    simulation.setSpeed(stepsPerSecond)
  }, [simulation.setSpeed])

  useEffect(() => {
    void restoreAutosave().then((restored) => {
      if (!restored || restored.presetId !== 'custom') return
      setMode('sandbox')
      setSelectedPreset('custom')
      setConfig(restored)
      setAppliedConfig(restored)
      simulation.initialize(restored)
    })
  }, [simulation.initialize])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (isRunning) pause(); else if (canRun) run()
      } else if (event.key === '.' && canRun && !isRunning) step()
      else if (event.key.toLowerCase() === 'r' && !isBusy) resetAppliedConfig()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRun, isBusy, isRunning, pause, resetAppliedConfig, run, step])

  const selectPreset = (id: Exclude<PresetId, 'custom'>) => {
    const next = clonePreset(id)
    setMode('guided')
    setSelectedPreset(id)
    setSelectedNucleusId(next.nuclei[0]?.id ?? null)
    setConfig(next)
    setAppliedConfig(next)
    setValidationError(null)
    simulation.initialize(next)
  }

  const setWorkspaceMode = (nextMode: 'guided' | 'sandbox') => {
    if (nextMode === mode) return
    if (nextMode === 'guided') {
      selectPreset(selectedPreset === 'custom' ? 'h2' : selectedPreset)
      return
    }
    const next = cloneAsSandbox(simulation.snapshot?.config ?? config)
    setMode('sandbox')
    setSelectedPreset('custom')
    setConfig(next)
    setAppliedConfig(next)
    simulation.initialize(next)
  }

  const moveNucleus = (id: string, position: Vector2) => {
    const next = structuredClone(config)
    const nucleus = next.nuclei.find((item) => item.id === id)
    if (!nucleus) return
    nucleus.position = position
    next.presetId = 'custom'
    applyConfig(next)
  }

  const handleExport = async () => {
    if (!simulation.snapshot) return
    const canvas = document.getElementById('simulation-canvas') as HTMLCanvasElement | null
    const preview = canvas ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png')) : null
    const bundle = await exportSession(simulation.snapshot, preview)
    downloadBlob(bundle, `hf2d-${config.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.hf2d.zip`)
  }

  const handleImport = async (file: File) => {
    try {
      const imported = await importSession(file)
      setMode('sandbox')
      setSelectedPreset('custom')
      setConfig(imported)
      setAppliedConfig(imported)
      setValidationError(null)
      simulation.initialize(imported)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Unable to import this session.')
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#simulation-canvas">Skip to simulation canvas</a>
      <TopBar
        mode={mode}
        isRunning={isRunning}
        canRun={canRun}
        isBusy={isBusy}
        needsScf={needsScf}
        canSolve={canSolve}
        onModeChange={setWorkspaceMode}
        onRun={simulation.run}
        onPause={simulation.pause}
        onSolve={solveScf}
        onStep={simulation.step}
        onReset={resetAppliedConfig}
      />
      <main className="workspace">
        <PresetRail selected={selectedPreset} mode={mode} onSelect={selectPreset} />
        <SimulationCanvas
          config={config}
          snapshot={displayedSnapshot}
          selectedNucleusId={selectedNucleusId}
          editable={mode === 'sandbox' && !isRunning && !isBusy}
          fieldView={activeFieldView}
          onSelectNucleus={setSelectedNucleusId}
          onMoveNucleus={moveNucleus}
        />
        <Inspector
          config={config}
          snapshot={displayedSnapshot}
          capabilities={simulation.capabilities}
          editable={mode === 'sandbox' && !isRunning && !isBusy}
          canEditDynamics={!isRunning && !isBusy}
          canEditScfPolicy={!isRunning && !isBusy}
          selectedNucleusId={selectedNucleusId}
          fieldView={activeFieldView}
          runSpeed={runSpeed}
          onFieldViewChange={setFieldView}
          onRunSpeedChange={handleRunSpeedChange}
          onConfigChange={applyConfig}
          onSelectNucleus={setSelectedNucleusId}
          onExport={handleExport}
          onImport={handleImport}
        />
      </main>
      <Diagnostics snapshot={displayedSnapshot} />
      <footer className="statusbar" aria-live="polite">
        <span className={`status-indicator ${simulation.error || validationError ? 'is-error' : !needsScf && simulation.snapshot?.scf.converged ? 'is-ready' : ''}`} />
        <span>{simulation.error || validationError || (needsScf ? 'Parameters changed · Solve SCF to apply' : simulation.progress?.message || simulation.snapshot?.message || 'Preparing real-space grid')}</span>
        {simulation.progress && <span className="status-progress"><LoaderCircle aria-hidden="true" /> iteration {simulation.progress.iteration} · residual {simulation.progress.residual.toExponential(2)}</span>}
        {(simulation.error || validationError) && <AlertTriangle aria-hidden="true" />}
        <span className="status-time">t = {(simulation.snapshot?.time ?? 0).toFixed(3)} au</span>
        <span className="status-model">Logarithmic 2D potential</span>
        <span>{config.dynamics.damping > 0 ? 'Damped Born–Oppenheimer dynamics' : 'Born–Oppenheimer dynamics'}</span>
        <span className="status-units">Units: a₀ (length) · au (time, energy)</span>
      </footer>
    </div>
  )
}
