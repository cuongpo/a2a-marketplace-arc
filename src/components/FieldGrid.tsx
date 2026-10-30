import { CloudFog, Lock, Radar, ShieldAlert, ShieldCheck, TimerOff } from 'lucide-react'
import type { TileCell } from '@/lib/api'

const COLS = ['A', 'B', 'C', 'D', 'E', 'F']
const ROWS = [1, 2, 3, 4]

/** Decorative terrain only (deterministic from the tile name). It is NOT survey data and carries no information. */
const TERRAINS = ['terrain-paddy', 'terrain-wet', 'terrain-canal', 'terrain-levee', 'terrain-pond'] as const
const terrainOf = (tile: string) => TERRAINS[(tile.charCodeAt(0) * 7 + Number(tile.slice(1)) * 13) % TERRAINS.length]

function stateLabel(c: TileCell): string {
  switch (c.state) {
    case 'fog':
      return 'unsurveyed'
    case 'active':
      return c.value !== undefined ? 'reading revealed, settling' : 'mission in progress'
    case 'revealed':
      return 'verified and paid'
    case 'rejected':
      return 'evidence rejected or disputed, buyer refunded'
    case 'expired':
      return 'expired, refunded'
    case 'blocked':
      return 'blocked'
  }
}

const CHIP: Record<TileCell['state'], { text: string; color: string }> = {
  fog: { text: 'FOG', color: 'var(--subtle)' },
  active: { text: 'LIVE', color: 'var(--accent)' },
  revealed: { text: 'PAID', color: 'var(--success)' },
  rejected: { text: 'REFUND', color: 'var(--danger)' },
  expired: { text: 'EXPIRED', color: 'var(--warn)' },
  blocked: { text: 'BLOCKED', color: 'var(--warn)' },
}

function Glyph({ s }: { s: TileCell['state'] }) {
  const p = { size: 14, 'aria-hidden': true } as const
  if (s === 'fog') return <CloudFog {...p} />
  if (s === 'active') return <Radar {...p} />
  if (s === 'revealed') return <ShieldCheck {...p} />
  if (s === 'rejected') return <ShieldAlert {...p} />
  if (s === 'expired') return <TimerOff {...p} />
  return <Lock {...p} />
}

export function FieldGrid({ cells, selected, onSelect }: { cells: TileCell[]; selected: string | null; onSelect: (t: string) => void }) {
  const by = new Map(cells.map((c) => [c.tile, c]))
  const count = (s: TileCell['state'][]) => cells.filter((c) => s.includes(c.state)).length
  const revealed = count(['revealed'])
  const live = count(['active'])
  const refunded = count(['rejected', 'expired'])
  const total = cells.length || 24

  return (
    <section aria-label="Mekong Delta field grid (fictional plots)" className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="label">Field board</div>
          <h2 className="display text-2xl font-bold">Mekong Delta terraces</h2>
          <p className="max-w-md text-xs text-[var(--subtle)] text-pretty">Fictional demo plots. Fog lifts only when a mission settles with a verified, paid reading.</p>
        </div>
        <dl className="flex gap-4 text-right" aria-label="Survey progress derived from mission states">
          <div>
            <dt className="label">Surveyed</dt>
            <dd className="display num text-2xl font-bold" style={{ color: 'var(--success)' }}>
              {revealed}
              <span className="text-base text-[var(--subtle)]"> / {total}</span>
            </dd>
          </div>
          <div>
            <dt className="label">Live</dt>
            <dd className="display num text-2xl font-bold">{live}</dd>
          </div>
          <div>
            <dt className="label">Refunded</dt>
            <dd className="display num text-2xl font-bold" style={{ color: refunded ? 'var(--danger)' : undefined }}>
              {refunded}
            </dd>
          </div>
        </dl>
      </div>

      <div className="board">
        <div className="board-grid" role="group" aria-label="Tiles">
          <span aria-hidden />
          {COLS.map((c) => (
            <span key={c} className="axis" aria-hidden>
              {c}
            </span>
          ))}
          {ROWS.map((r) => (
            <div key={r} className="contents">
              <span className="axis" aria-hidden>
                {r}
              </span>
              {COLS.map((col) => {
                const tile = `${col}${r}`
                const c = by.get(tile)
                if (!c) return <div key={tile} className="tile tile-fog opacity-50" aria-hidden><span className="terrain terrain-paddy" /><span className="fogveil" /></div>
                const chip = CHIP[c.state]
                return (
                  <button
                    key={tile}
                    type="button"
                    className={`tile tile-${c.state}`}
                    aria-pressed={selected === tile}
                    aria-label={`Tile ${tile}, ${stateLabel(c)}${c.value !== undefined ? `, reading ${c.value} millimetres${c.simulated ? ' (simulated)' : ''}` : ''}`}
                    onClick={() => onSelect(tile)}
                  >
                    <span className={`terrain ${terrainOf(tile)}`} aria-hidden />
                    <span className="fogveil" aria-hidden />
                    <span className="stamp" aria-hidden />
                    <span className="mono text-[10px] font-semibold sm:text-[11px]" style={{ textShadow: '0 1px 3px rgba(0,0,0,.8)' }}>
                      {tile}
                    </span>
                    {c.value !== undefined ? (
                      <span className="display num text-sm font-bold leading-none sm:text-xl" style={{ textShadow: '0 1px 4px rgba(0,0,0,.9)' }}>
                        {c.value}
                        <span className="text-[9px] font-medium opacity-80">mm</span>
                        {c.simulated ? <span className="block text-[8px] font-semibold tracking-wider text-[var(--warn)]">SIM</span> : null}
                      </span>
                    ) : (
                      <span className="tilechip" style={{ color: chip.color }}>
                        <Glyph s={c.state} />
                        <span className="hidden sm:inline">{chip.text}</span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--subtle)]" aria-label="Legend">
        <li>Fog: no mission yet</li>
        <li style={{ color: 'var(--accent)' }}>Radar sweep: mission live</li>
        <li style={{ color: 'var(--success)' }}>Green outline: verified and paid</li>
        <li style={{ color: 'var(--danger)' }}>Red hatch: rejected, refunded</li>
        <li style={{ color: 'var(--warn)' }}>Amber hatch: expired or blocked</li>
        <li>Terrain art is decorative, not survey data</li>
      </ul>
    </section>
  )
}
