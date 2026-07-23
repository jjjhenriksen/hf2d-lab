import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { Diagnostics } from './components/Diagnostics'
import { Inspector } from './components/Inspector'
import { PresetRail } from './components/PresetRail'
import { SimulationCanvas } from './components/SimulationCanvas'
import { TopBar } from './components/TopBar'
import { cloneAsSandbox, clonePreset } from './simulation/presets'
import { downloadBlob, exportSession, importSession, restoreAutosave } from './simulation/session'
import { validateConfig } from './simulation/schema'
import type { PresetId, RunSpeed, SimulationConfig, Vector2 } from './simulation/types'
import { useSimulation } from './simulation/use-simulation'

export function App() {
  const initialRef = useRef(clonePreset('h2'))
  const [config, setConfig] = useState<SimulationConfig>(initialRef.current)
  const [mode, setMode] = useState<'guided' | 'sandbox'>('guided')
  const [selectedPreset, setSelectedPreset] = useState<PresetId>('h2')
  const [selectedNucleusId, setSelectedNucleusId] = useState<string | null>('h-a')
  const [showSpin, setShowSpin] = useState(false)
  const [runSpeed, setRunSpeed] = useState<RunSpeed>(1)
  const [validationError, setValidationError] = useState<string | null>(null)
  const simulation = useSimulation(initialRef.current)
  const { pause, reset, run, step } = simulation
  const isRunning = simulation.snapshot?.status === 'running'
  const isBusy = Boolean(simulation.progress)
  const canRun = Boolean(simulation.snapshot?.scf.converged) && !simulation.error && !validationError

  const applyConfig = useCallback((next: SimulationConfig) => {
    try {
      const validated = validateConfig(next)
      setConfig(validated)
      setValidationError(null)
      simulation.initialize(validated)
    } catch (error) {
      setConfig(next)
      setValidationError(error instanceof Error ? error.message : 'Invalid configuration.')
    }
  }, [simulation.initialize])

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
      else if (event.key.toLowerCase() === 'r' && !isBusy) reset(config)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canRun, config, isBusy, isRunning, pause, reset, run, step])

  const selectPreset = (id: Exclude<PresetId, 'custom'>) => {
    const next = clonePreset(id)
    setMode('guided')
    setSelectedPreset(id)
    setSelectedNucleusId(next.nuclei[0]?.id ?? null)
    setConfig(next)
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
        onModeChange={setWorkspaceMode}
        onRun={simulation.run}
        onPause={simulation.pause}
        onStep={simulation.step}
        onReset={() => simulation.reset(config)}
      />
      <main className="workspace">
        <PresetRail selected={selectedPreset} mode={mode} onSelect={selectPreset} />
        <SimulationCanvas
          config={config}
          snapshot={simulation.snapshot}
          selectedNucleusId={selectedNucleusId}
          editable={mode === 'sandbox' && !isRunning && !isBusy}
          showSpin={showSpin}
          onSelectNucleus={setSelectedNucleusId}
          onMoveNucleus={moveNucleus}
        />
        <Inspector
          config={config}
          snapshot={simulation.snapshot}
          capabilities={simulation.capabilities}
          editable={mode === 'sandbox' && !isRunning && !isBusy}
          canEditDynamics={!isRunning && !isBusy}
          selectedNucleusId={selectedNucleusId}
          showSpin={showSpin}
          runSpeed={runSpeed}
          onShowSpinChange={setShowSpin}
          onRunSpeedChange={handleRunSpeedChange}
          onConfigChange={applyConfig}
          onSelectNucleus={setSelectedNucleusId}
          onExport={handleExport}
          onImport={handleImport}
        />
      </main>
      <Diagnostics snapshot={simulation.snapshot} />
      <footer className="statusbar" aria-live="polite">
        <span className={`status-indicator ${simulation.error || validationError ? 'is-error' : simulation.snapshot?.scf.converged ? 'is-ready' : ''}`} />
        <span>{simulation.error || validationError || simulation.progress?.message || simulation.snapshot?.message || 'Preparing real-space grid'}</span>
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
