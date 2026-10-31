import { useEffect, useState } from 'react'
import { ArrowRight, CircleCheck, Clock3, RotateCcw } from 'lucide-react'
import { short, usdc, type PMission } from '@/lib/api'
import { MarketRoom } from './MarketRoom'
import './trade-floor.css'

type Step = 'request' | 'quotes' | 'escrow' | 'delivery' | 'verdict' | 'settlement'
const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: 'request', label: 'Request', hint: 'Buyer signs the job' },
  { id: 'quotes', label: 'Bids', hint: 'Providers compete' },
  { id: 'escrow', label: 'Escrow', hint: 'USDC is locked' },
  { id: 'delivery', label: 'Delivery', hint: 'Evidence is committed' },
  { id: 'verdict', label: 'Verify', hint: 'Evidence is checked' },
  { id: 'settlement', label: 'Settle', hint: 'Pay or refund' },
]

function completed(m: PMission | null): Record<Step, boolean> {
  const status = m?.onchain?.status
  return {
    request: !!m,
    quotes: !!m?.decision,
    escrow: !!m?.chain,
    delivery: !!m?.evidenceHash || ['Submitted', 'Accepted', 'Rejected', 'Challenged', 'Settled'].includes(status ?? ''),
    verdict: !!m?.verdict || ['Accepted', 'Rejected', 'Challenged', 'Settled'].includes(status ?? ''),
    settlement: status === 'Settled' || status === 'Expired',
  }
}

export function TradeFloor({ mission, onOpenDetails }: { mission: PMission | null; onOpenDetails: () => void }) {
  const actualDone = completed(mission)
  const milestones = STEPS.filter((step) => actualDone[step.id])
  const [replay, setReplay] = useState<{ missionId: string; cursor: number } | null>(null)
  const activeReplay = replay !== null && replay.missionId === mission?.id && replay.cursor < milestones.length ? replay : null
  useEffect(() => {
    if (!activeReplay) return
    const timer = setTimeout(() => setReplay((previous) => {
      if (!previous || previous.missionId !== mission?.id) return previous
      return previous.cursor + 1 < milestones.length ? { ...previous, cursor: previous.cursor + 1 } : null
    }), 4500)
    return () => clearTimeout(timer)
  }, [activeReplay, mission?.id, milestones.length])
  const done = activeReplay ? Object.fromEntries(STEPS.map((step) => [step.id, milestones.slice(0, activeReplay.cursor + 1).some((past) => past.id === step.id)])) as Record<Step, boolean> : actualDone
  const blocked = mission?.stage === 'blocked' || mission?.stage === 'failed'
  const next = activeReplay ? milestones[activeReplay.cursor]?.id : STEPS.find((s) => !done[s.id])?.id
  const status = mission?.onchain?.status
  const paid = done.settlement && status === 'Settled' && mission?.onchain?.outcome === 'ProviderPaid'
  const refunded = done.settlement && (status === 'Expired' || (status === 'Settled' && mission?.onchain?.outcome === 'BuyerRefunded'))
  const split = done.settlement && status === 'Settled' && mission?.onchain?.outcome === 'Split'
  const winner = done.quotes ? mission?.decision?.scored.find((s) => s.quote.quoteId === mission.decision?.chosenQuoteId)?.quote : null
  const total = done.escrow && mission?.chain ? BigInt(mission.chain.providerPrice) + BigInt(mission.chain.verifierFee) : null
  const bidCount = activeReplay && !done.quotes ? 0 : mission?.quotes.length ?? 0
  const current = activeReplay ? `REPLAY ${activeReplay.cursor + 1}/${milestones.length} · ${milestones[activeReplay.cursor]?.label.toUpperCase()}` : blocked ? 'REQUEST STOPPED' : paid ? 'PROVIDER PAID' : refunded ? 'BUYER REFUNDED' : split ? 'SPLIT SETTLEMENT' : done.settlement ? 'TRADE SETTLED' : mission ? `${(next ?? 'settlement').toUpperCase()} IN PROGRESS` : 'AWAITING REQUEST'
  const speech = {
    buyer: mission ? mission.spec.objective.length > 28 ? `Request ${mission.spec.tile}: ${mission.spec.metric.replace(/_/g, ' ')}` : mission.spec.objective : 'Create a request',
    provider: winner ? `${usdc(BigInt(winner.priceUsdc))} USDC bid selected` : bidCount === 1 && mission?.quotes[0] ? `Bid: ${usdc(BigInt(mission.quotes[0].priceUsdc))} USDC` : bidCount > 1 ? `${bidCount} signed bids received` : 'Waiting for bids',
    escrow: paid && mission?.chain ? `${usdc(BigInt(mission.chain.providerPrice))} USDC paid to provider` : refunded ? 'Buyer refunded' : split ? 'Split payout' : total !== null ? `${usdc(total)} USDC locked` : 'No USDC locked',
    verifier: done.verdict && mission?.verdict ? `${mission.verdict.decision.toUpperCase()} verdict` : done.delivery ? 'Evidence submitted' : 'Awaiting evidence',
  }

  return <section className="trade-floor" aria-label="Live agent trade visualization">
    <div className="trade-floor-head">
      <div><span className="market-section-label">THE TRADING FLOOR</span><h2>Watch a trade unfold</h2><p>A living pixel room for buyers, providers, escrow and verification. Progress comes from the selected request.</p></div>
      <div className="trade-floor-head-actions">
        <div className={`trade-floor-current ${blocked || refunded ? 'warn' : paid || split ? 'done' : ''}`}><span className="market-live-dot" />{current}</div>
        {mission && actualDone.settlement && milestones.length > 1 ? <button type="button" className="trade-floor-details" onClick={() => setReplay(activeReplay ? null : { missionId: mission.id, cursor: 0 })}><RotateCcw size={13} /> {activeReplay ? 'Stop replay' : 'Replay trade'}</button> : null}
        {mission ? <button type="button" className="trade-floor-details" onClick={onOpenDetails}>Open trade details <ArrowRight size={13} /></button> : null}
      </div>
    </div>

    <div className="trade-floor-scene">
      <MarketRoom phase={blocked || (actualDone.settlement && !activeReplay) ? null : next ?? null} bids={bidCount} escrowed={done.escrow} evidence={done.delivery} settled={done.settlement} outcome={mission?.onchain?.outcome ?? null} speech={speech} />
    </div>
    <div className="trade-room-ledger" aria-label="Selected trade facts">
      <span><strong>BUYER</strong>{mission ? short(mission.operator, 6, 4) : 'No request'}</span>
      <span><strong>PROVIDERS</strong>{bidCount} verified bid{bidCount === 1 ? '' : 's'}{winner ? ` · ${winner.providerName}` : ''}</span>
      <span><strong>ESCROW</strong>{total !== null ? `${usdc(total)} USDC ${done.settlement ? 'settled' : 'locked'}` : 'No funds locked'}</span>
      <span><strong>VERIFIER</strong>{done.verdict && mission?.verdict ? `${mission.verdict.decision.toUpperCase()} verdict` : 'Awaiting evidence'}</span>
    </div>

    <div className="trade-floor-steps" role="list" aria-label="Trade progress">
      {STEPS.map((step, i) => <div role="listitem" key={step.id} className={`trade-step ${activeReplay && next === step.id ? 'active' : done[step.id] ? 'complete' : next === step.id && mission && !blocked ? 'active' : ''} ${blocked && next === step.id ? 'blocked' : ''}`}>
        <span className="trade-step-index">{done[step.id] ? <CircleCheck size={14} /> : i + 1}</span>
        <span><strong>{step.label}</strong><small>{step.hint}</small></span>
        {next === step.id && mission && !blocked ? <Clock3 className="trade-step-now" size={13} aria-label={activeReplay ? 'Replay step' : 'Current step'} /> : null}
      </div>)}
    </div>
    <p className="trade-floor-note">{activeReplay ? `Replaying ${mission?.spec.tile} from recorded milestones. Current onchain status remains unchanged.` : mission ? `Showing ${mission.spec.tile} · ${mission.scenario === 'custom' ? 'open provider auction' : 'scripted demo'} · ${mission.stage.replace(/_/g, ' ')}` : 'Select a request slot below to follow a real trade.'} Select an agent to read its message. Characters and walking paths explain the protocol; they do not represent physical agent locations.</p>
  </section>
}
