import { Trophy } from 'lucide-react'
import { usdc, type PMission } from '@/lib/api'
import { Badge, Empty } from './ui'

const CAP: Record<string, string> = {
  'signed-device': 'Signed device',
  'signed-device+photo': 'Signed device + photo',
  'field-operator': 'Field operator',
}

export function BidList({ m }: { m: PMission }) {
  if (!m.decision) {
    if (!m.quotes.length) return <Empty title="Bids">{m.stage === 'blocked' ? (m.stageNote ?? 'No eligible bids') : 'Public auction is open. Provider wallets can submit signed quotes below.'}</Empty>
    return <div><div className="label mb-2">Live bids · {m.quotes.length}</div><ul className="space-y-2">{m.quotes.map((q) => <li key={q.quoteId} className="inset flex flex-wrap items-center justify-between gap-2 p-3 text-xs"><span className="font-semibold">{q.providerName}</span><span className="num">{usdc(q.priceUsdc)} USDC · ETA {Math.round(q.etaSec / 60)}m</span></li>)}</ul><p className="mt-2 text-xs text-[var(--subtle)]">Buyer agent scores the signed bids when the auction closes.</p></div>
  }
  return (
    <div>
      <div className="label mb-2">Provider bids (EIP-712 signed, signature verified by the buyer agent)</div>
      <ul className="space-y-2">
        {m.decision.scored.map((s) => {
          const won = s.quote.quoteId === m.decision!.chosenQuoteId
          return (
            <li key={s.quote.quoteId} className={`inset p-3 ${won ? 'border-[var(--accent)]' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {won ? <Trophy size={14} aria-label="selected" /> : null}
                  {s.quote.providerName}
                </span>
                <span className="display num text-lg font-bold">{usdc(s.quote.priceUsdc)} USDC</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--subtle)]">
                <Badge>{CAP[s.quote.evidenceCapability]}</Badge>
                <span>ETA {Math.round(s.quote.etaSec / 60)} min</span>
                <span className="num">score {s.score.toFixed(3)}</span>
                {s.excluded ? <Badge tone="bad">excluded: {s.excluded}</Badge> : null}
                {s.quote.simulated ? <Badge tone="sim">simulated provider pricing</Badge> : null}
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-[var(--subtle)]" aria-label="score breakdown">
                {(['price', 'capability', 'reliability', 'deadline'] as const).map((k) => (
                  <div key={k}>
                    <div className="h-1.5 overflow-hidden rounded bg-white/10">
                      <div className="h-full bg-[var(--accent)]" style={{ width: `${Math.round(s.parts[k] * 100)}%` }} />
                    </div>
                    {k}
                  </div>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-xs text-[var(--muted)] text-pretty">{m.decision.rationale}</p>
    </div>
  )
}
