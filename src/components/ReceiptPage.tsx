import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, ShieldCheck, ShieldX } from 'lucide-react'
import { hashTypedData, recoverMessageAddress, recoverTypedDataAddress, type Address } from 'viem'
import { toast } from 'sonner'
import { navigate, usdc, useApi } from '@/lib/api'
import { buildShareLink } from '@/lib/share'
import { hashCanonical } from '@/shared/canonical'
import { readingTypes, registryDomain } from '@/shared/typed'
import type { EvidenceBundle, FeedbackRecord, MissionSpec, SecondSourceRecord } from '@/shared/types'
import { AddrLink, Badge, Empty, ErrorBox, SimBadge, Stat, TxLink } from './ui'

interface Receipt {
  onchainId: string
  tile: string | null
  network: 'testnet' | 'mainnet'
  chainId: number
  explorer: string
  escrow: string
  registry: string
  status: string
  outcome: string
  mission: Record<string, string | number>
  spec: MissionSpec | null
  specHashMatches: boolean | null
  evidence: EvidenceBundle | null
  evidenceHashMatchesOnchain: boolean | null
  verdict: { decision: string; reasons: { code: string; ok: boolean; detail: string }[]; reasonHash: string } | null
  settlement: Record<string, string> | null
  events: { name: string; args: Record<string, unknown>; txHash: string; block: string }[]
  simulated: boolean | null
  secondSource: SecondSourceRecord | null
  feedback?: FeedbackRecord | null
  providerAgent?: { agentId: string; displayName: string } | null
  invitedProvider?: boolean | null
}
interface Proof {
  label: string
  ok: boolean | null
  detail: string
}

export async function computeProofs(r: Receipt): Promise<Proof[]> {
  const out: Proof[] = []
  const zero = '0x' + '0'.repeat(64)
  const committed = String(r.mission.evidenceHash)
  if (!r.evidence) {
    out.push({ label: 'Evidence bundle', ok: null, detail: committed === zero ? 'No evidence was committed for this mission.' : 'The bundle is not available from this server, so the commitment cannot be checked here.' })
    return out
  }
  const h = hashCanonical(r.evidence)
  out.push({ label: 'Evidence hash matches the mission commitment', ok: h.toLowerCase() === committed.toLowerCase(), detail: `keccak256 of the canonical bundle, recomputed in your browser: ${h.slice(0, 20)}...` })
  const e = r.evidence
  const msg = {
    missionId: BigInt(e.reading.missionId),
    tileId: e.reading.tileId,
    observedAt: BigInt(e.reading.observedAt),
    value: BigInt(e.reading.value),
    unit: e.reading.unit,
    nonce: BigInt(e.reading.nonce),
    payloadHash: e.reading.payloadHash,
  }
  const domain = registryDomain(r.chainId, r.registry as Address)
  const digest = hashTypedData({ domain, types: readingTypes, primaryType: 'Reading', message: msg })
  out.push({ label: 'Reading digest matches the onchain reading commitment', ok: digest.toLowerCase() === String(r.mission.readingCommitment).toLowerCase(), detail: 'EIP-712 digest of the signed reading, recomputed in your browser.' })
  try {
    const signer = await recoverTypedDataAddress({ domain, types: readingTypes, primaryType: 'Reading', message: msg, signature: e.signature })
    out.push({ label: 'Signature recovers to the declared device key', ok: signer.toLowerCase() === e.signer.toLowerCase(), detail: `device key ${signer}. A valid signature proves key possession, not physical truth.` })
  } catch {
    out.push({ label: 'Signature recovers to the declared device key', ok: false, detail: 'Signature could not be recovered.' })
  }
  if (r.spec) out.push({ label: 'Mission spec matches the onchain objective hash', ok: hashCanonical(r.spec).toLowerCase() === String(r.mission.objectiveHash).toLowerCase(), detail: 'Canonical spec hash recomputed in your browser.' })
  if (r.verdict) out.push({ label: 'Verdict reasons match the signed reason hash', ok: hashCanonical({ decision: r.verdict.decision, reasons: r.verdict.reasons }).toLowerCase() === String(r.mission.verdictReasonHash).toLowerCase(), detail: 'The verifier signed this reasonHash; the listed reasons hash to it.' })
  if (r.secondSource) {
    const s = r.secondSource
    const payload = { schema: s.schema, missionId: s.missionId, tile: s.tile, valueMm: s.valueMm, observedAt: s.observedAt, sourceId: s.sourceId, provenance: s.provenance }
    const hash = hashCanonical(payload)
    let recovered = ''
    try { recovered = await recoverMessageAddress({ message: { raw: hash }, signature: s.signature }) } catch { /* invalid signature */ }
    out.push({ label: 'Paid reference signature and mission binding', ok: recovered.toLowerCase() === s.signer.toLowerCase() && hash.toLowerCase() === s.payloadHash.toLowerCase() && s.missionId === r.onchainId && s.tile === (r.spec?.tile ?? r.tile) && s.signer.toLowerCase() !== String(r.mission.provider).toLowerCase(), detail: `Reference operator ${s.signer}; payload ${hash.slice(0, 20)}...` })
  }
  return out
}

const EVENT_LABEL: Record<string, string> = {
  MissionCreated: 'Escrow funded from buyer vault',
  MissionAssigned: 'Provider accepted assignment',
  EvidenceSubmitted: 'Evidence hash + reading commitment submitted',
  VerdictRecorded: 'Verifier signed verdict recorded',
  MissionChallenged: 'Verdict challenged',
  MissionEscalated: 'Escalated to human review',
  ArbiterResolved: 'Arbiter ruled',
  MissionSettled: 'Settlement credited',
  MissionExpired: 'Mission expired, refund credited',
  CreditAdded: 'Withdrawable credit added',
  RefundClaimed: 'Refund claimed back to buyer vault',
  Withdrawn: 'Wallet withdrew credited USDC (provider or verifier wallet)',
}

export function ReceiptPage({ refId }: { refId: string }) {
  const { data, error, loading } = useApi<Receipt>(`/receipt/${refId}`, 8000)
  const [proofs, setProofs] = useState<Proof[] | null>(null)
  const [link, setLink] = useState<string | null>(null)

  useEffect(() => {
    if (data) void computeProofs(data).then(setProofs)
  }, [data])
  useEffect(() => {
    void buildShareLink(`/receipt/${refId}`).then(setLink)
  }, [refId])

  const tone = data?.outcome === 'ProviderPaid' ? 'ok' : data?.status === 'Settled' || data?.status === 'Expired' ? 'bad' : 'warn'
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
        <ArrowLeft size={16} aria-hidden /> Mission control
      </button>
      {loading && !data ? <Empty title="Loading receipt">Reading the escrow contract and its events...</Empty> : null}
      {error && !data ? <ErrorBox message={`Receipt unavailable: ${error}`} /> : null}
      {data ? (
        <>
          <section className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="label">Public receipt: evidence and payment</div>
                <h1 className="display text-3xl font-bold">
                  Request {data.spec?.tile ?? data.tile ?? '?'} <span className="text-[var(--subtle)]">mission #{data.onchainId}</span>
                </h1>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={data.network === 'mainnet' ? 'bad' : 'warn'}>{data.network === 'mainnet' ? 'ARC MAINNET' : 'ARC TESTNET (test USDC)'}</Badge>
                <Badge tone={tone}>{data.status}</Badge>
                <Badge tone={tone}>{data.outcome}</Badge>
                {data.simulated ? <SimBadge label="SIMULATED SENSOR FIXTURE" /> : null}
              </div>
            </div>
            {data.spec ? <p className="mt-2 text-sm text-[var(--muted)]">{data.spec.objective}</p> : null}
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Reading" value={data.evidence ? `${data.evidence.reading.value} mm` : 'not revealed'} />
              <Stat label="Provider price" value={usdc(String(data.mission.providerPrice))} sub="USDC" />
              <Stat label="Verifier fee" value={usdc(String(data.mission.verifierFee))} sub="USDC" />
              <Stat label="Decision" value={String(data.verdict?.decision ?? '-')} />
            </div>
            {data.simulated ? (
              <p className="mt-3 rounded-xl border border-[rgba(241,194,122,0.4)] bg-[rgba(241,194,122,0.08)] p-3 text-xs text-[var(--warn)] text-pretty">
                This reading came from a SIMULATED sensor fixture on testnet. The payment is real testnet USDC movement, but the observation is not a physical measurement.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--subtle)]">
              <span>Escrow</span>
              <AddrLink chainId={data.chainId} address={data.escrow} />
              <span>Provider</span>
              <AddrLink chainId={data.chainId} address={String(data.mission.provider)} />
              <span>Verifier</span>
              <AddrLink chainId={data.chainId} address={String(data.mission.verifier)} />
            </div>
            <button
              type="button"
              className="btn btn-ghost mt-3"
              disabled={!link}
              onClick={() => {
                if (link) void navigator.clipboard.writeText(link).then(() => toast.success('Receipt link copied'))
              }}
            >
              <Copy size={16} aria-hidden /> Copy shareable link
            </button>
          </section>

          <section className="card p-5" aria-label="Independent checks in your browser">
            <div className="label mb-2">Checks recomputed in your browser</div>
            {!proofs ? <p className="text-sm text-[var(--subtle)]">Computing...</p> : null}
            <ul className="space-y-2">
              {proofs?.map((p) => (
                <li key={p.label} className="flex items-start gap-2 text-sm">
                  {p.ok === true ? <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--success)]" aria-label="passed" /> : <ShieldX size={16} className={`mt-0.5 shrink-0 ${p.ok === false ? 'text-[var(--danger)]' : 'text-[var(--warn)]'}`} aria-label={p.ok === false ? 'failed' : 'unknown'} />}
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-[var(--subtle)]">{p.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[var(--subtle)] text-pretty">
              These checks show the evidence on file is exactly what was committed onchain and was signed by the stated device key. They do not prove the physical world matched the
              reading. Reputation and signatures are not proof of truth.
            </p>
          </section>

          {data.verdict ? (
            <section className="card p-5">
              <div className="label mb-2">Verifier reasoning</div>
              <ul className="space-y-1 text-xs">
                {data.verdict.reasons.map((r) => (
                  <li key={r.code}>
                    <span className={r.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>{r.ok ? 'pass' : 'FAIL'}</span> <span className="mono">{r.code}</span> <span className="text-[var(--subtle)]">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {data.secondSource ? <section className="card p-5" aria-label="Paid second source">
            <div className="label mb-2">Paid reference source</div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Reference" value={`${data.secondSource.valueMm} mm`} sub={data.secondSource.sourceId} />
              <Stat label="Paid" value={usdc(data.secondSource.priceUsdc)} sub="USDC via Gateway/x402" />
              <Stat label="Provenance" value={data.secondSource.provenance} />
              <Stat label="Difference" value={data.evidence ? `${Math.abs(data.secondSource.valueMm - Number(data.evidence.reading.value))} mm` : '-'} />
            </div>
            <p className="mt-3 break-all text-xs text-[var(--subtle)]">Gateway payment reference: {data.secondSource.paymentReference}. Gateway authorizations may settle in a later onchain batch; this is not necessarily an individual Arc transaction hash.</p>
          </section> : null}

          {data.providerAgent || data.feedback || data.invitedProvider !== null && data.invitedProvider !== undefined ? <section className="card p-5" aria-label="Agent identity and ERC-8004 feedback">
            <div className="label mb-2">Agent identity and ERC-8004 feedback</div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Provider agent" value={data.providerAgent ? `#${data.providerAgent.agentId}` : 'not in directory'} sub={data.providerAgent?.displayName} />
              <Stat label="Invited" value={data.invitedProvider === null || data.invitedProvider === undefined ? '-' : data.invitedProvider ? 'yes' : 'no (open bid)'} sub="invitations are recommendations" />
              <Stat label="Feedback" value={data.feedback ? data.feedback.status : 'none recorded'} sub={data.feedback?.reason} />
              <Stat label="Feedback tx" value={data.feedback?.txHash ? 'confirmed' : '-'} />
            </div>
            {data.feedback?.entries.length ? <ul className="mt-3 space-y-1 text-xs text-[var(--muted)]">
              {data.feedback.entries.map((e) => <li key={e.role}>{e.role} agent #{e.agentId}: {e.outcome === 'recorded' ? `recorded, value ${e.value ?? 'n/a'} / 100` : 'registry rejected the feedback (not counted)'}</li>)}
            </ul> : null}
            {(data.feedback?.txHashes ?? (data.feedback?.txHash ? [data.feedback.txHash] : [])).map((hash, i) =>
              <div className="mt-2" key={hash}><TxLink chainId={data.chainId} hash={hash} label={`ERC-8004 feedback transaction ${i + 1}`} /></div>)}
            <p className="mt-3 text-xs text-[var(--subtle)]">Feedback is posted by this marketplace&apos;s adapter from the final escrow outcome. Reputation is a social signal, not proof that a reading is true.</p>
          </section> : null}

          <section className="card p-5" aria-label="Onchain events">
            <div className="label mb-2">Onchain events (from the escrow contract)</div>
            <ol className="space-y-2">
              {data.events.map((e, i) => (
                <li key={`${e.txHash}-${i}`} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--ink-2)]">{EVENT_LABEL[e.name] ?? e.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="mono text-[var(--subtle)]">block {e.block}</span>
                    <TxLink chainId={data.chainId} hash={e.txHash} />
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </main>
  )
}
