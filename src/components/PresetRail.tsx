import { ChevronRight } from 'lucide-react'
import { PRESET_ORDER, PRESETS } from '../simulation/presets'
import type { PresetId } from '../simulation/types'

interface PresetRailProps {
  selected: PresetId
  mode: 'guided' | 'sandbox'
  onSelect: (id: Exclude<PresetId, 'custom'>) => void
}

export function PresetRail({ selected, mode, onSelect }: PresetRailProps) {
  return (
    <aside className="preset-rail" aria-label="Guided experiment presets">
      <div className="rail-label">Presets</div>
      <nav>
        {PRESET_ORDER.map((id) => (
          <button key={id} className={selected === id && mode === 'guided' ? 'is-active' : ''} onClick={() => onSelect(id)}>
            <span>{PRESETS[id].title}</span>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </nav>
      <div className="rail-context">
        <p>{mode === 'guided' ? PRESETS[selected === 'custom' ? 'h2' : selected].description : 'Edit nuclei and numerical controls directly. Structural changes begin a new trajectory.'}</p>
      </div>
    </aside>
  )
}
