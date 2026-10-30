import { CheckCircle2, XCircle } from 'lucide-react'
import { short, type PMission } from '@/lib/api'
import { Badge, Empty, SimBadge } from './ui'

export function EvidencePanel({ m }: { m: PMission }) {
  const b = m.evidencePreview
  const v = m.verdict
  if (!b && !v) {
    return <Empty title="Evidence">No evidence has been submitted onchain yet. The tile stays in fog until a signed reading is committed and verified.</Empty>
  }
  return (
    <div className="space-y-3">
      {b ? (
        <div className="inset p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="label">Reading (public preview)</div>
              <div className="display num text-4xl font-bold">
                {b.reading.value}
                <span className="ml-1 text-base font-medium text-[var(--subtle)]">{m.spec.unit}</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              {b.provenance.simulated ? <SimBadge label="SIMULATED FIXTURE" /> : <Badge tone="neutral">{b.provenance.kind}</Badge>}
              {m.onchain && m.onchain.evidenceHash !== '0x' + '0'.repeat(64) ? <Badge tone="ok">hash committed onchain</Badge> : null}
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)] text-pretty">{b.provenance.label}</p>
          <dl className="mono mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px] text-[var(--subtle)]">
            <dt>evidence hash</dt>
            <dd className="break-all">{short(m.evidenceHash ?? m.onchain?.evidenceHash ?? '', 14, 10)}</dd>
            <dt>device key</dt>
            <dd>{short(b.signer, 8, 6)}</dd>
            <dt>device serial</dt>
            <dd>{b.provenance.deviceSerialMasked ?? 'not published'}</dd>
            <dt>observed</dt>
            <dd>{new Date(b.reading.observedAt * 1000).toISOString()}</dd>
          </dl>
          <p className="mt-2 text-[11px] text-[var(--subtle)]">Raw device payload and operator notes are private. Only their digest is committed.</p>
        </div>
      ) : null}
      {v ? (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <div className="label">Verifier checks (deterministic, no model)</div>
            <Badge tone={v.decision === 'accept' ? 'ok' : v.decision === 'reject' ? 'bad' : 'warn'}>{v.decision.toUpperCase()}</Badge>
          </div>
          <ul className="space-y-1">
            {v.reasons.map((r) => (
              <li key={r.code} className="flex items-start gap-2 text-xs">
                {r.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--success)]" aria-label="passed" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" aria-label="failed" />}
                <span>
                  <span className="mono text-[var(--ink-2)]">{r.code}</span> <span className="text-[var(--subtle)]">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
