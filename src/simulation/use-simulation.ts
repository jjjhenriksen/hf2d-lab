import { useCallback, useEffect, useRef, useState } from 'react'
import { autosaveSnapshot } from './session'
import type { BackendCapabilities, SimulationConfig, SimulationSnapshot, WorkerRequest, WorkerResponse } from './types'

type WorkerCommand =
  | { type: 'reconfigure'; config: SimulationConfig }
  | { type: 'run' }
  | { type: 'setSpeed'; stepsPerSecond: number }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reset'; config: SimulationConfig }
  | { type: 'cancel' }

export interface SolverProgress {
  iteration: number
  residual: number
  message: string
}

export function useSimulation(initialConfig: SimulationConfig) {
  const workerRef = useRef<Worker | null>(null)
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null)
  const [progress, setProgress] = useState<SolverProgress | null>(null)
  const [capabilities, setCapabilities] = useState<BackendCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const post = useCallback((request: WorkerCommand) => {
    const id = `request-${++requestId.current}`
    workerRef.current?.postMessage({ ...request, id } as WorkerRequest)
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (response.type === 'snapshot') {
        setSnapshot(response.snapshot)
        setProgress(null)
        setError(null)
        void autosaveSnapshot(response.snapshot)
      } else if (response.type === 'progress') {
        setProgress({ iteration: response.iteration, residual: response.residual, message: response.message })
      } else if (response.type === 'capabilities') setCapabilities(response.capabilities)
      else if (response.type === 'error') {
        setError(response.message)
        setProgress(null)
      }
    }
    worker.onerror = (event) => setError(event.message || 'The simulation worker crashed.')
    const id = `request-${++requestId.current}`
    worker.postMessage({ id, type: 'initialize', config: initialConfig } satisfies WorkerRequest)
    return () => worker.terminate()
  }, []) // The worker owns subsequent configuration updates.

  return {
    snapshot,
    progress,
    capabilities,
    error,
    initialize: useCallback((config: SimulationConfig) => post({ type: 'reconfigure', config }), [post]),
    run: useCallback(() => post({ type: 'run' }), [post]),
    setSpeed: useCallback((stepsPerSecond: number) => post({ type: 'setSpeed', stepsPerSecond }), [post]),
    pause: useCallback(() => post({ type: 'pause' }), [post]),
    step: useCallback(() => post({ type: 'step' }), [post]),
    reset: useCallback((config: SimulationConfig) => post({ type: 'reset', config }), [post]),
    cancel: useCallback(() => post({ type: 'cancel' }), [post]),
  }
}
