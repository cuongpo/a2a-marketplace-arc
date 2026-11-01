import { useEffect, useState } from 'react'
import { FileCheck2 } from 'lucide-react'
import { navigate, usdc, type Overview, type PMission } from '@/lib/api'
import { ActionPanel, fmtLeft } from './ActionPanel'
import { AgentTrack } from './AgentTrack'
import { BidList } from './BidList'
import { ProviderBid } from './ProviderBid'
import { ProviderFulfillment } from './ProviderFulfillment'
import { EvidencePanel } from './EvidencePanel'
import { PaidReferencePanel } from './PaidReferencePanel'
import { Badge, ErrorBox, Stat, TxLink } from './ui'

export function MissionDetail({ m, ov, onChange }: { m: PMission; ov: Overview | null; onChange: () => void }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])
  const chainId = ov?.chainId ?? 5042002
  const left = m.spec.deadlineUnix - now
  const tone = m.onchain?.outcome === 'ProviderPaid' ? 'ok' : m.stage === 'blocked' ? 'warn' : m.onchain?.status === 'Expired' || m.onchain?.outcome === 'BuyerRefunded' ? 'bad' : 'neutral'
  const failedJobs = Object.values(m.jobs).filter((j) => j.status === 'failed')

  return (
    <div className="space-y-4">
      <section className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="label">Mission {m.chain ? `#${m.chain.onchainId}` : m.id}</div>
            <h2 className="display text-2xl font-bold">Request {m.spec.tile}</h2>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={tone}>{m.onchain?.status ?? m.stage}</Badge>
            {m.onchain && m.onchain.outcome !== 'None' ? <Badge tone={tone}>{m.onchain.outcome}</Badge> : null}
            {m.scenario !== 'custom' ? <Badge tone="sim">scripted demo: {m.scenario}</Badge> : null}
          </div>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)] text-pretty">{m.spec.objective}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Max budget" value={`${usdc(m.spec.budgetUsdc)}`} sub="USDC" />
          <Stat label="Provider price" value={m.chain ? usdc(m.chain.providerPrice) : '-'} sub="USDC, escrowed" />
          <Stat label="Verifier fee" value={m.chain ? usdc(m.chain.verifierFee) : '-'} sub="USDC, escrowed" />
          <Stat label="Deadline" value={m.onchain?.status === 'Settled' || m.onchain?.status === 'Expired' ? 'closed' : fmtLeft(left)} sub={new Date(m.spec.deadlineUnix * 1000).toLocaleTimeString()} />
        </div>
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-[var(--subtle)]">
          {m.spec.evidenceRequirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="mono mt-2 text-[11px] text-[var(--subtle)]">spec hash {m.specHash.slice(0, 18)}... committed as objectiveHash</div>
        {m.stage === 'blocked' ? <div className="mt-3"><ErrorBox message={m.stageNote ?? 'Blocked'} /></div> : null}
        {failedJobs.length > 0 ? (
          <div className="mt-3">
            <ErrorBox message={`Agent step failing: ${failedJobs.map((j) => `${j.key}: ${j.lastError}`).join(' | ')}`} />
          </div>
        ) : null}
        {m.chain ? (
          <button type="button" className="btn btn-ghost mt-3" onClick={() => navigate(`/receipt/${m.chain!.onchainId}`)}>
            <FileCheck2 size={16} aria-hidden /> Open public receipt
          </button>
        ) : null}
      </section>

      <AgentTrack m={m} />
      {ov?.readOnly ? null : <PaidReferencePanel m={m} ov={ov} onChange={onChange} />}

      <section className="card space-y-4 p-4 sm:p-5">
        <BidList m={m} />
        {ov?.readOnly ? null : <ProviderBid m={m} ov={ov} onChange={onChange} />}
        {ov?.readOnly ? null : <ProviderFulfillment m={m} ov={ov} onChange={onChange} />}
        {ov?.readOnly ? null : <ActionPanel m={m} ov={ov} onChange={onChange} />}
        <EvidencePanel m={m} />
      </section>

      <section className="card p-4 sm:p-5" aria-label="Confirmed transactions">
        <div className="label mb-2">Confirmed transactions</div>
        {m.txs.length === 0 ? (
          <p className="text-sm text-[var(--subtle)]">No transaction has been confirmed for this mission yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {m.txs.map((t) => (
              <li key={t.hash} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[var(--ink-2)]">{t.label}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={t.status === 'success' ? 'ok' : t.status === 'reverted' ? 'bad' : 'warn'}>{t.status}</Badge>
                  <TxLink chainId={chainId} hash={t.hash} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
