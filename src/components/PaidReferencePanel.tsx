import { useState } from 'react'
import { useRoles, useSignedPost } from '@/lib/auth'
import { short, usdc, type Overview, type PMission } from '@/lib/api'
import { AddrLink, Badge, ErrorBox } from './ui'

export function PaidReferencePanel({ m, ov, onChange }: { m: PMission; ov: Overview | null; onChange: () => void }) {
  const signedPost = useSignedPost()
  const roles = useRoles(m, ov)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!m.spec.requireSecondSource) return null
  const source = m.secondSource
  const failed = m.jobs.second_source?.status === 'failed'
  const canRetry = !source && (!!m.secondSourceAttemptAt || failed) && m.stage === 'evidence_submitted' && roles.isOperator
  return <section className="card space-y-3 p-4 sm:p-5" aria-label="Paid second-source verification">
    <div className="flex flex-wrap items-center gap-2"><div className="label">Paid reference source</div><Badge tone={source ? 'ok' : m.secondSourceAttemptAt || failed ? 'warn' : 'neutral'}>{source ? 'PURCHASED' : m.secondSourceAttemptAt || failed ? 'REVIEW NEEDED' : 'AWAITING EVIDENCE'}</Badge></div>
    {source ? <div className="grid gap-2 text-xs sm:grid-cols-2">
      <p><strong>{source.sourceId}</strong><br />{source.valueMm} mm · {source.provenance}<br />Observed {new Date(source.observedAt * 1000).toLocaleString()}</p>
      <p>Paid {usdc(source.priceUsdc)} USDC via Gateway/x402<br />Signer <AddrLink chainId={m.chain?.chainId ?? 5042002} address={source.signer} /><br />Payment reference <span className="mono">{short(source.paymentReference, 12, 8)}</span></p>
    </div> : <p className="text-xs text-[var(--subtle)]">{m.secondSourceAttemptAt ? 'A payment attempt may have reached Gateway without a confirmed response. The operator must review the Gateway balance before authorizing another attempt.' : failed ? `Reference preflight failed: ${m.jobs.second_source?.lastError ?? 'unknown error'}. Confirm funding and seller availability before retrying.` : ov?.referenceConfigured ? 'After primary evidence is submitted, the buyer agent pays the separate reference service and verifies its signed reading.' : 'The reference service is not configured. No second-source result will be invented.'}</p>}
    {canRetry ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
      setBusy(true); setError(null)
      void signedPost(`/missions/${m.id}/reference/retry`, {}).then(onChange).catch((e: unknown) => setError(e instanceof Error ? e.message : 'retry failed')).finally(() => setBusy(false))
    }}>{busy ? 'Waiting for signature...' : 'Authorize another paid attempt (0.001 USDC)'}</button> : null}
    {error ? <ErrorBox message={error} /> : null}
  </section>
}
