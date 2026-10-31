import { useEffect, useState } from 'react'
import { ArrowRight, CircleCheck, Clock3, Coins, Fingerprint, LockKeyhole, Radio, RotateCcw, ScanSearch, ShieldCheck } from 'lucide-react'
import { short, usdc, type PMission } from '@/lib/api'
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
const BASE = '/assets/modern-tiles/'

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

function actor(name: 'Adam' | 'Amelia' | 'Alex' | 'Bob', busy: boolean) {
  return <span aria-hidden="true" className={`trade-actor ${busy ? 'trade-actor-busy' : ''}`} style={{ backgroundImage: `url("${BASE}${name}_${busy ? 'run' : 'idle_anim'}_16x16.png")` }} />
}

function station({ role, title, status, detail, who, active, done, child }: {
  role: string; title: string; status: string; detail: string; who: 'Adam' | 'Amelia' | 'Alex' | 'Bob'; active: boolean; done: boolean; child: React.ReactNode
}) {
  return <div className={`trade-station trade-station-${role} ${active ? 'trade-station-active' : ''} ${done ? 'trade-station-done' : ''}`}>
    <span className="trade-station-eyebrow"><span className={`trade-station-led ${active ? 'on' : ''}`} /> {role.toUpperCase()}</span>
    <div className="trade-station-stage"><div className="trade-station-prop" aria-hidden="true" />{actor(who, active)}</div>
    <strong>{title}</strong>
    <span className="trade-station-state">{child} {status}</span>
    <small title={detail}>{detail}</small>
  </div>
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
    }), 1250)
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
  const current = activeReplay ? `REPLAY ${activeReplay.cursor + 1}/${milestones.length} · ${milestones[activeReplay.cursor]?.label.toUpperCase()}` : blocked ? 'REQUEST STOPPED' : paid ? 'PROVIDER PAID' : refunded ? 'BUYER REFUNDED' : split ? 'SPLIT SETTLEMENT' : done.settlement ? 'TRADE SETTLED' : mission ? `${(next ?? 'settlement').toUpperCase()} IN PROGRESS` : 'AWAITING REQUEST'

  return <section className="trade-floor" aria-label="Live agent trade visualization">
    <div className="trade-floor-head">
      <div><span className="market-section-label">THE TRADING FLOOR</span><h2>Watch a trade unfold</h2><p>Characters show the roles. Every status below comes from this request and its Arc Testnet state.</p></div>
      <div className="trade-floor-head-actions"><div className={`trade-floor-current ${blocked || refunded ? 'warn' : paid || split ? 'done' : ''}`}><span className="market-live-dot" />{current}</div>{mission && actualDone.settlement && milestones.length > 1 ? <button type="button" className="trade-floor-details" onClick={() => setReplay(activeReplay ? null : { missionId: mission.id, cursor: 0 })}><RotateCcw size={13} /> {activeReplay ? 'Stop replay' : 'Replay trade'}</button> : null}{mission ? <button type="button" className="trade-floor-details" onClick={onOpenDetails}>Open trade details <ArrowRight size={13} /></button> : null}</div>
    </div>

    <div className="trade-floor-scene">
      <div className="trade-floor-wall" aria-hidden="true"><span>A2A / EXCHANGE</span><span>ARC TESTNET</span></div>
      <div className="trade-floor-stations">
        {station({ role: 'buyer', title: 'Buyer agent', who: 'Adam', active: !!mission && (next === 'request' || next === 'quotes'), done: done.request,
          status: mission ? 'Request posted' : 'Waiting for a request', detail: mission ? `Operator ${short(mission.operator, 6, 4)}` : 'A buyer opens a signed request', child: <Fingerprint size={12} /> })}
        {station({ role: 'providers', title: 'Provider agents', who: 'Amelia', active: !!mission && next === 'quotes' && !blocked, done: done.quotes,
          status: mission ? `${activeReplay && !done.quotes ? 0 : mission.quotes.length} verified bid${mission.quotes.length === 1 && (!activeReplay || done.quotes) ? '' : 's'}` : 'No bids yet', detail: winner ? `Selected: ${winner.providerName}` : 'Wallet-signed bids are ranked by the buyer', child: <Radio size={12} /> })}
        {station({ role: 'escrow', title: 'Arc escrow', who: 'Bob', active: !!mission && next === 'escrow' && !blocked, done: done.escrow,
          status: total !== null ? `${usdc(total)} USDC ${done.settlement ? 'settled' : 'locked'}` : 'No funds locked', detail: mission?.chain ? `Mission #${mission.chain.onchainId}` : 'Funds move only after a provider is selected', child: <LockKeyhole size={12} /> })}
        {station({ role: 'verifier', title: 'Verifier agent', who: 'Alex', active: !!mission && (next === 'delivery' || next === 'verdict') && !blocked, done: done.verdict,
          status: done.verdict && mission?.verdict ? `${mission.verdict.decision.toUpperCase()} verdict` : 'Awaiting evidence', detail: done.delivery && mission?.evidenceHash ? `Evidence ${short(mission.evidenceHash, 8, 6)}` : 'Checks the signed reading before settlement', child: <ShieldCheck size={12} /> })}
      </div>
      <div className={`trade-floor-transfer ${mission ? 'has-mission' : ''}`} aria-hidden="true">
        <span className={`trade-transfer-token ${activeReplay && next === 'quotes' ? 'active' : done.quotes ? 'passed' : next === 'quotes' ? 'active' : ''}`}><Radio size={13} /> BID</span>
        <ArrowRight size={17} />
        <span className={`trade-transfer-token ${activeReplay && next === 'escrow' ? 'active' : done.escrow ? 'passed' : next === 'escrow' ? 'active' : ''}`}><Coins size={13} /> USDC</span>
        <ArrowRight size={17} />
        <span className={`trade-transfer-token ${activeReplay && next === 'delivery' ? 'active' : done.delivery ? 'passed' : next === 'delivery' ? 'active' : ''}`}><ScanSearch size={13} /> PROOF</span>
        <ArrowRight size={17} />
        <span className={`trade-transfer-token ${activeReplay && (next === 'verdict' || next === 'settlement') ? 'active' : done.settlement ? 'passed' : next === 'verdict' || next === 'settlement' ? 'active' : ''}`}>{paid ? <CircleCheck size={13} /> : <Coins size={13} />} {paid ? 'PAID' : refunded ? 'REFUND' : split ? 'SPLIT' : 'RESULT'}</span>
      </div>
    </div>

    <div className="trade-floor-steps" role="list" aria-label="Trade progress">
      {STEPS.map((step, i) => <div role="listitem" key={step.id} className={`trade-step ${activeReplay && next === step.id ? 'active' : done[step.id] ? 'complete' : next === step.id && mission && !blocked ? 'active' : ''} ${blocked && next === step.id ? 'blocked' : ''}`}>
        <span className="trade-step-index">{done[step.id] ? <CircleCheck size={14} /> : i + 1}</span>
        <span><strong>{step.label}</strong><small>{step.hint}</small></span>
        {next === step.id && mission && !blocked ? <Clock3 className="trade-step-now" size={13} aria-label={activeReplay ? 'Replay step' : 'Current step'} /> : null}
      </div>)}
    </div>
    <p className="trade-floor-note">{activeReplay ? `Replaying ${mission?.spec.tile} from recorded milestones. Current onchain status remains unchanged.` : mission ? `Showing ${mission.spec.tile} · ${mission.scenario === 'custom' ? 'open provider auction' : 'scripted demo'} · ${mission.stage.replace(/_/g, ' ')}` : 'Select a request slot below to follow a real trade.'} Visual movement explains protocol steps; it does not represent physical agent locations.</p>
  </section>
}
