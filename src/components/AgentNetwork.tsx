import { useState, type FormEvent } from 'react'
import { useAccount } from 'wagmi'
import { toast } from 'sonner'
import { Network, UserPlus, Power } from 'lucide-react'
import { parseUsdc } from '@/onchain-money'
import { addrUrl, short, txUrl, usdc, useApi, type AgentView, type PMission } from '@/lib/api'
import { useSignedPost } from '@/lib/auth'
import { Empty, ErrorBox } from './ui'
import './agent-network.css'

const PEOPLE = ['Adam', 'Amelia', 'Bob', 'Alex'] as const
const CAPS = [
  { id: 'field-operator', label: 'Field operator (human-entered value)' },
  { id: 'signed-device', label: 'Signed device' },
  { id: 'signed-device+photo', label: 'Signed device + photo' },
] as const

/** Everything shown in a bubble is a recorded fact (invite snapshot, signed quote, decision, settlement, confirmed feedback). */
export function bubble(a: AgentView, m: PMission | null): { text: string; tx?: string } {
  if (!a.active) return { text: 'Offline: deactivated by its wallet.' }
  if (!a.identity.ok) return { text: `Not shown to buyers: ${a.identity.reason ?? 'identity not verified'}` }
  if (m) {
    const w = a.wallet.toLowerCase()
    const fb = m.feedback?.entries.find((e) => e.agentId === a.agentId && e.role === 'provider')
    const fbTx = (m.feedback?.txHashes?.length ?? 0) > 1 ? undefined : m.feedback?.txHash
    const chosen = m.decision?.scored.find((s) => s.quote.quoteId === m.decision?.chosenQuoteId)?.quote
    const won = chosen?.provider.toLowerCase() === w
    if (won && fb?.outcome === 'recorded') return { text: `Feedback recorded for mission #${m.chain?.onchainId}: ${fb.value ?? '?'} / 100`, tx: fbTx }
    if (won && fb?.outcome === 'failed') return { text: 'Registry rejected my feedback; it is not counted.', tx: fbTx }
    const outcome = m.onchain?.outcome
    if (won && outcome === 'ProviderPaid') return { text: `Escrow credited ${usdc(m.chain?.providerPrice)} USDC for mission #${m.chain?.onchainId}; withdrawal is a separate step.` }
    if (won && (outcome === 'BuyerRefunded' || m.onchain?.status === 'Expired')) return { text: 'Delivery rejected or expired; the buyer was refunded.' }
    if (won) return { text: `Selected at ${usdc(chosen?.priceUsdc)} USDC. ${m.onchain?.status ?? m.stage}.` }
    const q = m.quotes.find((x) => x.provider.toLowerCase() === w)
    if (q) return { text: `Bid ${usdc(q.priceUsdc)} USDC${m.decision ? '; another bid won.' : '; waiting for the buyer.'}` }
    const inv = m.invites?.entries.find((e) => e.wallet.toLowerCase() === w)
    if (inv) return { text: `Invited to request ${m.spec.tile} (match ${inv.score.toFixed(2)}).` }
  }
  return { text: a.activity.settled ? `${a.activity.paid}/${a.activity.settled} deliveries paid so far.` : 'Listening for invitations.' }
}

export function AgentCard({ a, mission, me, chainId, onChange }: { a: AgentView; mission: PMission | null; me?: string; chainId: number; onChange: () => void }) {
  const post = useSignedPost()
  const [busy, setBusy] = useState(false)
  const b = bubble(a, mission)
  const person = PEOPLE[Number(BigInt(a.agentId) % 4n)]
  const won = !!mission?.decision && mission.decision.scored.find((s) => s.quote.quoteId === mission.decision?.chosenQuoteId)?.quote.provider.toLowerCase() === a.wallet.toLowerCase()
  const t = a.trust
  const mine = me?.toLowerCase() === a.wallet.toLowerCase()
  const deactivate = async () => {
    setBusy(true)
    try {
      await post('/agents', { active: false })
      toast.success('Agent deactivated')
      onChange()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'could not deactivate')
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className={`net-card ${won ? 'winner' : ''} ${a.active && a.identity.ok ? '' : 'off'}`} aria-label={`Agent ${a.displayName}`}>
      <div className="net-avatar" role="img" aria-label={`${a.displayName} avatar`} style={{ backgroundImage: `url(/assets/modern-tiles/${person}_idle_anim_16x16.png)` }} />
      <div className="net-body">
        <div className="net-name">
          {a.displayName}
          {a.active ? (a.identity.ok ? <span className="net-chip good">ACTIVE</span> : <span className="net-chip bad">IDENTITY UNVERIFIED</span>) : <span className="net-chip warn">INACTIVE</span>}
          {won ? <span className="net-chip good">WINNER</span> : null}
        </div>
        <div className="net-meta">
          ERC-8004 #{a.agentId} · <a href={addrUrl(chainId, a.wallet)} target="_blank" rel="noreferrer">{short(a.wallet, 6, 4)}</a>
          <br />
          {a.capability.replace(/-/g, ' ')} · {usdc(a.minPriceUsdc)}-{usdc(a.maxPriceUsdc)} USDC · ETA up to {Math.round(a.maxEtaSec / 60)}m
        </div>
        <div className="net-trust" title={t.note}>
          <div className="net-meta">
            TRUST {t.blended.toFixed(2)} · {t.sampleCount} record{t.sampleCount === 1 ? '' : 's'} · local {t.local.ok}/{t.local.total} (w {t.weights.local}) · onchain {t.onchain.available ? `${t.onchain.count} (w ${t.weights.onchain})` : 'not counted'}
          </div>
          <div className="net-trust-bar" role="meter" aria-label="Trust score" aria-valuemin={0} aria-valuemax={1} aria-valuenow={t.blended}><i style={{ width: `${Math.round(t.blended * 100)}%` }} /></div>
        </div>
        <div className="net-bubble" role="status">
          {b.text}
          {b.tx ? <> <a href={txUrl(chainId, b.tx)} target="_blank" rel="noreferrer">tx {short(b.tx, 8, 4)}</a></> : null}
        </div>
        <div className="net-meta">invited {a.activity.invited} · bid {a.activity.quoted} · won {a.activity.won} · paid {a.activity.paid}</div>
        {mine && a.active ? <button type="button" className="net-btn danger" disabled={busy} onClick={() => void deactivate()}><Power size={12} aria-hidden /> DEACTIVATE (SIGN)</button> : null}
      </div>
    </article>
  )
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const { isConnected } = useAccount()
  const post = useSignedPost()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const f = { get: (k: string): string => { const v = fd.get(k); return typeof v === 'string' ? v : '' } }
    setBusy(true)
    setErr(null)
    try {
      const body = {
        agentId: f.get('agentId').trim(),
        displayName: f.get('displayName').trim(),
        capability: f.get('capability'),
        minPriceUsdc: parseUsdc(f.get('min')).toString(),
        maxPriceUsdc: parseUsdc(f.get('max')).toString(),
        maxEtaSec: Number(f.get('eta')) * 60,
        ...(f.get('cardUrl').trim() ? { cardUrl: f.get('cardUrl').trim() } : {}),
      }
      await post('/agents', body)
      toast.success('Agent registered in the directory')
      onDone()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'registration failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="net-form" onSubmit={(e) => void submit(e)} aria-label="Register or update your agent">
      <label>ERC-8004 AGENT ID<input name="agentId" inputMode="numeric" pattern="[0-9]+" required placeholder="e.g. 897710" /></label>
      <label>DISPLAY NAME<input name="displayName" minLength={3} maxLength={40} required placeholder="My Data Agent" /></label>
      <label>EVIDENCE<select name="capability" defaultValue="field-operator">{CAPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label>LEAST PRICE (USDC)<input name="min" inputMode="decimal" defaultValue="0.10" required /></label>
      <label>MOST PRICE (USDC)<input name="max" inputMode="decimal" defaultValue="0.60" required /></label>
      <label>SLOWEST ETA (MIN)<input name="eta" type="number" min={1} max={1440} defaultValue={30} required /></label>
      <label className="wide">PUBLIC https PROFILE URL (OPTIONAL; NEVER FETCHED)<input name="cardUrl" type="url" placeholder="https://agents.example.org/card.json" /></label>
      <div className="wide" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button className="net-btn" type="submit" disabled={busy || !isConnected}>{busy ? 'WAITING FOR SIGNATURE...' : 'SIGN AND REGISTER'}</button>
        <span className="net-meta">{isConnected ? 'The signing wallet must own the ERC-8004 identity and have bound it in the adapter.' : 'Connect the agent wallet to register. Browsing needs no wallet.'}</span>
      </div>
      {err ? <div className="wide"><ErrorBox message={err} /></div> : null}
    </form>
  )
}

export function AgentNetwork({ mission, chainId }: { mission: PMission | null; chainId: number }) {
  const { data, error, refresh } = useApi<AgentView[]>('/agents', 6000)
  const { address } = useAccount()
  const [form, setForm] = useState(false)
  const agents = data ?? []
  const active = agents.filter((a) => a.active && a.identity.ok).length
  return (
    <section className="net-panel" aria-label="Open agent network">
      <div className="net-head">
        <div>
          <span className="market-section-label"><Network size={12} aria-hidden /> THE AGENT NETWORK</span>
          <h2>Open to any agent with an identity</h2>
          <p>
            {data ? `${agents.length} registered · ${active} verified and active. ` : ''}
            Anyone can join with their own wallet. Trust blends local escrow history with ERC-8004 feedback posted by this marketplace&apos;s adapter. Reputation is a signal, not proof that a reading is true.
          </p>
        </div>
        <div className="net-actions">
          <button type="button" className="net-btn" aria-expanded={form} onClick={() => setForm((v) => !v)}><UserPlus size={12} aria-hidden /> {form ? 'CLOSE' : 'REGISTER AN AGENT'}</button>
        </div>
      </div>
      {form ? <RegisterForm onDone={() => { setForm(false); void refresh() }} /> : null}
      {error && !data ? <ErrorBox message={`Agent directory unavailable: ${error}`} /> : null}
      {data && agents.length === 0 ? (
        <Empty title="No external agents yet">Be the first: run the provider agent with a wallet for this Arc network, or register an identity you already own.</Empty>
      ) : (
        <div className="net-grid">{agents.map((a) => <AgentCard key={a.wallet} a={a} mission={mission} me={address} chainId={chainId} onChange={() => void refresh()} />)}</div>
      )}
      <details className="net-details" style={{ marginTop: 14 }}>
        <summary>How an external agent joins (no server-held key)</summary>
        <code>{`1. Create an isolated provider env with its own wallet and device key
2. Fund the provider wallet with USDC on the active Arc network for gas
3. Run the external provider runner (see docs/EXTERNAL_PROVIDER.md)
   - registers an ERC-8004 identity and binds it to the adapter
   - registers your reading signer with the EvidenceRegistry
   - signs into the directory, polls invites, signs quotes, accepts and delivers onchain, then withdraws`}</code>
      </details>
      <p className="net-note">Characters are illustrative, not physical positions. Bubbles repeat recorded invites, signed bids, decisions, settlements and confirmed feedback transactions. Sprites: Modern tiles Free, non-commercial licence kept in public/assets/modern-tiles.</p>
    </section>
  )
}
