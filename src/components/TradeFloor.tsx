import { useEffect, useState } from 'react'
import { ArrowRight, CircleCheck, Clock3, RotateCcw } from 'lucide-react'
import { short, usdc, type PMission } from '@/lib/api'
import { MarketRoom, type FloorProvider } from './MarketRoom'
import { TxLink } from './ui'
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
  const [selection, setSelection] = useState<{ missionId: string; quoteId: string | null } | null>(null)
  const selectedQuoteId = selection?.missionId === mission?.id ? selection?.quoteId ?? null : null
  const selectQuote = (quoteId: string | null) => setSelection({ missionId: mission?.id ?? '', quoteId })
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
  const quotes = activeReplay && !done.quotes ? [] : mission?.quotes ?? []
  const selectedId = quotes.some((quote) => quote.quoteId === selectedQuoteId) ? selectedQuoteId : null
  const inspectedId = selectedId ?? winner?.quoteId ?? quotes[0]?.quoteId
  const selectedQuote = quotes.find((quote) => quote.quoteId === inspectedId)
  const selectedScore = done.quotes ? mission?.decision?.scored.find((entry) => entry.quote.quoteId === inspectedId) : null
  const floorProviders: FloorProvider[] = quotes.map((quote) => ({
    id: quote.quoteId,
    name: quote.providerName,
    price: usdc(BigInt(quote.priceUsdc)),
    etaMinutes: Math.round(quote.etaSec / 60),
    winner: quote.quoteId === winner?.quoteId,
    excluded: !!mission?.decision?.scored.find((entry) => entry.quote.quoteId === quote.quoteId)?.excluded,
  }))
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
      <MarketRoom key={mission?.id ?? 'empty'} phase={blocked || (actualDone.settlement && !activeReplay) ? null : next ?? null} providers={floorProviders} selectedProviderId={selectedId} onSelectProvider={selectQuote} escrowed={done.escrow} evidence={done.delivery} settled={done.settlement} outcome={mission?.onchain?.outcome ?? null} speech={speech} />
    </div>
    {quotes.length > 0 ? <div className="floor-auction" aria-label="Signed provider bids">
      <div className="floor-auction-title"><span>PROVIDER AUCTION</span><strong>{quotes.length} signed bid{quotes.length === 1 ? '' : 's'}{winner ? ' · winner selected' : blocked ? ' · auction stopped' : mission?.stage === 'quoting' ? ' · accepting bids' : ' · awaiting decision'}</strong></div>
      <div className="floor-bid-row">
        {quotes.map((quote) => <button key={quote.quoteId} type="button" className={`floor-bid ${inspectedId === quote.quoteId ? 'selected' : ''} ${winner?.quoteId === quote.quoteId ? 'winner' : ''}`} aria-pressed={inspectedId === quote.quoteId} onClick={() => selectQuote(quote.quoteId)}>
          <span className="floor-bid-name"><i />{quote.providerName}{winner?.quoteId === quote.quoteId ? ' ★' : ''}</span>
          <strong>{usdc(BigInt(quote.priceUsdc))} USDC</strong>
          <small>ETA {Math.round(quote.etaSec / 60)}m</small>
        </button>)}
      </div>
      {selectedQuote ? <div className="floor-bid-inspector" aria-live="polite">
        <div><span className="floor-inspector-kicker">SELECTED AGENT</span><strong>{selectedQuote.providerName}</strong><small>{selectedQuote.provider}</small></div>
        <div><span className="floor-inspector-kicker">SIGNED OFFER</span><strong>{usdc(BigInt(selectedQuote.priceUsdc))} USDC</strong><small>{selectedQuote.evidenceCapability.replace(/-/g, ' ')} · ETA {Math.round(selectedQuote.etaSec / 60)}m</small></div>
        <div><span className="floor-inspector-kicker">BUYER DECISION</span><strong>{winner?.quoteId === inspectedId ? 'Selected winner' : selectedScore?.excluded ? `Excluded: ${selectedScore.excluded}` : mission?.decision ? 'Not selected' : 'Auction open'}</strong><small>{selectedScore ? `Score ${selectedScore.score.toFixed(3)}` : 'EIP-712 quote accepted by marketplace'}</small></div>
        <details><summary>Inspect signature</summary><span>Quote ID: {selectedQuote.quoteId}</span><code>{selectedQuote.signature}</code></details>
      </div> : null}
    </div> : null}
    {mission && (done.escrow || done.delivery || done.verdict || done.settlement) ? <div className="floor-proof" aria-label="Trade proof">
      <strong>ARC TRADE PROOF</strong>
      {done.escrow && mission.chain ? <span>Escrow #{mission.chain.onchainId} · {usdc(BigInt(mission.chain.providerPrice) + BigInt(mission.chain.verifierFee))} USDC</span> : null}
      {done.delivery && mission.evidenceHash ? <span>Evidence {short(mission.evidenceHash, 12, 8)}</span> : null}
      {done.verdict && mission.verdict ? <span>Verdict {mission.verdict.decision.toUpperCase()}</span> : null}
      {done.settlement ? <span>{mission.onchain?.outcome ?? mission.onchain?.status}</span> : null}
      {!activeReplay && mission.chain && mission.txs.filter((tx) => tx.status === 'success').slice(-2).map((tx) => <TxLink key={tx.hash} chainId={mission.chain!.chainId} hash={tx.hash} label={tx.label} />)}
      <button type="button" onClick={onOpenDetails}>Open evidence and transactions <ArrowRight size={13} /></button>
    </div> : null}
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
