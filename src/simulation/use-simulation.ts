import { useCallback, useEffect, useRef, useState } from 'react'
import { autosaveSnapshot } from './session'
import type { BackendCapabilities, RunSpeed, SimulationConfig, SimulationSnapshot, WorkerRequest, WorkerResponse } from './types'

type WorkerCommand =
  | { type: 'reconfigure'; config: SimulationConfig }
  | { type: 'run' }
  | { type: 'setSpeed'; stepsPerSecond: RunSpeed }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset'; config: SimulationConfig }
  | { type: 'setBaseline' }
  | { type: 'cancel' }

export interface SolverProgress {
  iteration: number
  residual: number
  energy: number
  message: string
}

export function useSimulation(initialConfig: SimulationConfig) {
  const workerRef = useRef<Worker | null>(null)
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null)
  const [progress, setProgress] = useState<SolverProgress | null>(null)
  const [capabilities, setCapabilities] = useState<BackendCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [persistenceWarning, reportPersistenceWarning] = useState<string | null>(null)
  const requestId = useRef(0)
  const activeResponseId = useRef('')
  const speedResponseId = useRef('')

  const post = useCallback((request: WorkerCommand) => {
    const id = `request-${++requestId.current}`
    if (request.type === 'setSpeed') speedResponseId.current = id
    else {
      activeResponseId.current = id
      speedResponseId.current = ''
      setProgress(null)
      setError(null)
    }
    workerRef.current?.postMessage({ ...request, id } as WorkerRequest)
  }, [])

  useEffect(() => {
    let active = true
    let saveGeneration = 0
    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (!active) return
      if (response.id !== activeResponseId.current) {
        if (response.type !== 'error' || response.id !== speedResponseId.current) return
        speedResponseId.current = ''
      }
      if (response.type === 'snapshot') {
        setSnapshot(response.snapshot)
        setProgress(null)
        setError(null)
        if (response.snapshot.scf.converged) {
          const generation = ++saveGeneration
          void autosaveSnapshot(response.snapshot).then((warning) => {
            if (active && generation === saveGeneration && response.id === activeResponseId.current) reportPersistenceWarning(warning)
          })
        }
      } else if (response.type === 'progress') {
        setProgress({ iteration: response.iteration, residual: response.residual, energy: response.energy, message: response.message })
      } else if (response.type === 'capabilities') setCapabilities(response.capabilities)
      else if (response.type === 'error') {
        setError(response.message)
        setProgress(null)
      }
    }
    worker.onerror = (event) => setError(event.message || 'The simulation worker crashed.')
    const id = `request-${++requestId.current}`
    activeResponseId.current = id
    speedResponseId.current = ''
    worker.postMessage({ id, type: 'initialize', config: initialConfig } satisfies WorkerRequest)
    return () => {
      active = false
      worker.terminate()
      workerRef.current = null
    }
  }, []) // The worker owns subsequent configuration updates.

  return {
    snapshot,
    progress,
    capabilities,
    error,
    persistenceWarning,
    reportPersistenceWarning,
    initialize: useCallback((config: SimulationConfig) => post({ type: 'reconfigure', config }), [post]),
    run: useCallback(() => post({ type: 'run' }), [post]),
    setSpeed: useCallback((stepsPerSecond: RunSpeed) => post({ type: 'setSpeed', stepsPerSecond }), [post]),
    pause: useCallback(() => post({ type: 'pause' }), [post]),
    step: useCallback(() => post({ type: 'step' }), [post]),
    reset: useCallback((config: SimulationConfig) => post({ type: 'reset', config }), [post]),
    setBaseline: useCallback(() => post({ type: 'setBaseline' }), [post]),
    cancel: useCallback(() => post({ type: 'cancel' }), [post]),
  }
}
