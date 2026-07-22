import { Pause, Play, RefreshCw, StepForward } from 'lucide-react'

interface TopBarProps {
  mode: 'guided' | 'sandbox'
  isRunning: boolean
  canRun: boolean
  isBusy: boolean
  onModeChange: (mode: 'guided' | 'sandbox') => void
  onRun: () => void
  onPause: () => void
  onStep: () => void
  onReset: () => void
}

export function TopBar({ mode, isRunning, canRun, isBusy, onModeChange, onRun, onPause, onStep, onReset }: TopBarProps) {
  return (
    <header className="topbar">
      <h1>2D Hartree–Fock Lab</h1>
      <div className="mode-switch" role="group" aria-label="Workspace mode">
        <button className={mode === 'guided' ? 'is-active' : ''} onClick={() => onModeChange('guided')}>Guided experiments</button>
        <button className={mode === 'sandbox' ? 'is-active' : ''} onClick={() => onModeChange('sandbox')}>Open sandbox</button>
      </div>
      <div className="transport" role="group" aria-label="Simulation controls">
        <button className="primary-control" onClick={onRun} disabled={!canRun || isRunning}>
          <Play aria-hidden="true" /> Run
        </button>
        <button onClick={onPause} disabled={!isRunning}><Pause aria-hidden="true" /> Pause</button>
        <button onClick={onStep} disabled={!canRun || isRunning || isBusy}><StepForward aria-hidden="true" /> Step</button>
        <button onClick={onReset} disabled={isBusy}><RefreshCw aria-hidden="true" /> Reset</button>
      </div>
    </header>
  )
}
