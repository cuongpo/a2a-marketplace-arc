import { useState } from 'react'
import { ArrowRight, DatabaseZap, Fingerprint, Sparkles } from 'lucide-react'
import { usdc, type PMission, type TileCell } from '@/lib/api'
import { TradeFloor } from './TradeFloor'
import { AgentNetwork } from './AgentNetwork'
import './marketplace.css'

type Filter = 'all' | 'open' | 'bidding' | 'working' | 'paid' | 'refunded'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All requests' }, { id: 'open', label: 'Available' },
  { id: 'bidding', label: 'Bidding' }, { id: 'working', label: 'In progress' },
  { id: 'paid', label: 'Paid' }, { id: 'refunded', label: 'Refunded' },
]

function phase(c: TileCell): Exclude<Filter, 'all'> {
  if (c.state === 'fog') return 'open'
  if (c.quoteDeadlineUnix) return 'bidding'
  if (c.state === 'active') return 'working'
  if (c.state === 'revealed') return 'paid'
  return 'refunded'
}

const phaseLabel: Record<Exclude<Filter, 'all'>, string> = {
  open: 'AVAILABLE', bidding: 'BIDS OPEN', working: 'IN PROGRESS', paid: 'PAID', refunded: 'CLOSED',
}

export function MarketplaceBoard({ cells, selected, onSelect }: { cells: TileCell[]; selected: string | null; onSelect: (slot: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const filtered = cells.filter((c) => filter === 'all' || phase(c) === filter)
  const count = (p: Filter) => cells.filter((c) => p === 'all' || phase(c) === p).length

  return (
    <section className="market-shell" aria-label="A2A Marketplace request board">
      <div className="market-board-head">
        <div><span className="market-section-label">THE EXCHANGE</span><h2>Request board <small>{cells.length || 24} slots</small></h2><p>Current service category: signed water-level data. Select an available slot to open a request.</p></div>
        <span className="market-chain-pill"><Fingerprint size={14} /> WALLET-SIGNED ACTIONS</span>
      </div>
      <div className="market-filters" role="group" aria-label="Filter requests">
        {FILTERS.map((f) => <button type="button" key={f.id} className={filter === f.id ? 'market-filter active' : 'market-filter'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<span>{count(f.id)}</span></button>)}
      </div>

      {filtered.length ? <div className="market-grid">
        {filtered.map((c) => {
          const p = phase(c)
          return <button type="button" key={c.tile} onClick={() => onSelect(c.tile)} aria-pressed={selected === c.tile} aria-label={`Request slot ${c.tile}, ${phaseLabel[p]}`} className={`market-card market-card-${p}${selected === c.tile ? ' selected' : ''}`}>
            <span className="market-card-top"><span className="market-card-id">REQ / {c.tile}</span><span className={`market-status market-status-${p}`}>{phaseLabel[p]}</span></span>
            <span className="market-card-art"><DatabaseZap size={25} strokeWidth={1.6} /><span className="market-card-orbit"><Sparkles size={10} /></span></span>
            <span className="market-card-title">Verified data request</span>
            <span className="market-card-sub">Water level · signed reading</span>
            <span className="market-card-bottom"><span>{p === 'open' ? 'CREATE REQUEST' : p === 'bidding' ? `${c.bidCount ?? 0} BIDS RECEIVED` : p === 'paid' ? `${c.value ?? '—'} mm · ${c.simulated ? 'SIM' : 'SIGNED'}` : c.budgetUsdc ? `${usdc(c.budgetUsdc)} USDC MAX` : 'VIEW TRADE'}</span><ArrowRight size={14} /></span>
          </button>
        })}
      </div> : <div className="market-empty">No requests in this view. Pick another filter or open a new request.</div>}

      <div className="market-foot"><span><span className="market-live-dot" /> Chain state and payment receipts are live.</span><span>Demo fixtures are labelled SIMULATED. A signed reading proves key control, not physical truth.</span></div>
    </section>
  )
}

export function MarketplaceStage({ cells, mission, chainId, onOpenDetails }: { cells: TileCell[]; mission: PMission | null; chainId: number; onOpenDetails: () => void }) {
  const count = (p: Exclude<Filter, 'all'>) => cells.filter((c) => phase(c) === p).length
  return <section className="market-shell market-stage" aria-label="A2A Marketplace trading floor">
    <div className="market-hero">
      <div className="market-hero-copy">
        <span className="market-kicker"><span className="market-live-dot" /> LIVE ON ARC / AGENT ECONOMY</span>
        <h1>Agent-to-agent <span>commerce, visible.</span></h1>
        <p>Post a data request. Provider agents bid, USDC enters escrow, and a verifier decides the payout.</p>
      </div>
      <div className="market-hero-stats" aria-label="Marketplace activity">
        <div><strong>{cells.length || '—'}</strong><span>REQUEST SLOTS</span></div>
        <div><strong>{cells.length ? count('bidding') + count('working') : '—'}</strong><span>LIVE TRADES</span></div>
        <div><strong>{cells.length ? count('paid') : '—'}</strong><span>PAID OUT</span></div>
      </div>
    </div>
    <TradeFloor mission={mission} onOpenDetails={onOpenDetails} />
    <AgentNetwork mission={mission} chainId={chainId} />
  </section>
}
