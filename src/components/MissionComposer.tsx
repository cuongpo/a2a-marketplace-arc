import { useState } from 'react'
import { useAccount } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Send, Wallet } from 'lucide-react'
import { useApi, usdc, type Overview, type PMission, type VaultInfo } from '@/lib/api'
import { useSignedPost } from '@/lib/auth'
import { parseUsdc } from '@/onchain-money'
import { ErrorBox, SimBadge } from './ui'

type Scenario = 'custom' | 'accept' | 'reject' | 'dispute'
const SCENARIOS: { id: Scenario; title: string; body: string; sim: boolean }[] = [
  { id: 'custom', title: 'Open A2A auction', body: 'External provider wallets bid during a public quote window. The winning provider accepts and delivers onchain.', sim: false },
  { id: 'accept', title: 'Scripted: accepted journey', body: 'Provider A wins; a SIMULATED sensor fixture feeds a plausible reading; payout and withdrawal.', sim: true },
  { id: 'reject', title: 'Scripted: rejected journey', body: 'Provider B wins on price; a SIMULATED fixture sends an implausible reading; rejection and refund.', sim: true },
  { id: 'dispute', title: 'Scripted: dispute journey', body: 'A SIMULATED primary reading can disagree with a paid, signed reference. The verifier then escalates for arbiter review.', sim: true },
]

export function MissionComposer({ tile, ov, onCreated, onOpenVault }: { tile: string; ov: Overview | null; onCreated: (m: PMission) => void; onOpenVault: () => void }) {
  const [scenario, setScenario] = useState<Scenario>('custom')
  const [budget, setBudget] = useState('1.00')
  const [minutes, setMinutes] = useState('30')
  const [quoteWindow, setQuoteWindow] = useState('90')
  const [secondSource, setSecondSource] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { address, isConnected } = useAccount()
  const signedPost = useSignedPost()
  const vault = useApi<VaultInfo>(address ? `/vault/${address}` : null, 5000)

  let budgetBad: string | null = null
  let budgetRaw = 0n
  try {
    budgetRaw = parseUsdc(budget)
    if (budgetRaw <= BigInt(ov?.verifierFeeUsdc ?? '0')) budgetBad = 'Budget must exceed the verifier fee'
    if (budgetRaw > parseUsdc('5')) budgetBad = 'Demo budget limit is 5 USDC'
  } catch {
    budgetBad = 'Enter a USDC amount with at most 6 decimals'
  }
  const sim = SCENARIOS.find((s) => s.id === scenario)?.sim ?? false
  const authorised = vault.data?.authorised === true
  const overBudget = vault.data ? budgetRaw > BigInt(vault.data.available) : false
  const disabled = busy || !isConnected || !ov?.deployed || !!budgetBad || !authorised || overBudget || (sim && !ov.fixtureEnabled) || ((secondSource || scenario === 'dispute') && !ov.referenceConfigured)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      const m = await signedPost<PMission>('/missions', {
        tile,
        scenario,
        budgetUsdc: budget,
        deadlineMinutes: Number(minutes),
        quoteWindowSec: scenario === 'custom' ? Number(quoteWindow) : undefined,
        autoFixture: scenario === 'accept' || scenario === 'reject',
        requireSecondSource: scenario === 'dispute' || secondSource,
      })
      onCreated(m)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card p-4 sm:p-5" aria-label={`Open a request in slot ${tile}`}>
      <div className="label">New A2A request</div>
      <h2 className="display text-2xl font-bold">Request slot {tile}</h2>
      <p className="mt-1 text-sm text-[var(--muted)] text-pretty">
        Current marketplace service: a signed water-level data point (mm). Independent provider agents submit bids, and the buyer agent funds an escrow from <strong>your</strong> vault budget only
        if your vault policy allows it. You sign the request with your wallet; signing moves no funds.
      </p>

      <div className="mt-3 inset p-3 text-xs" aria-live="polite">
        {!isConnected ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[var(--muted)]">Browsing is open to everyone. Opening a mission needs the operator wallet that owns the budget.</span>
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button type="button" className="btn btn-primary !min-h-[36px]" onClick={show}>
                  <Wallet size={14} aria-hidden /> Connect wallet
                </button>
              )}
            </ConnectKitButton.Custom>
          </div>
        ) : vault.loading && !vault.data ? (
          <span className="text-[var(--subtle)]">Reading your vault policy from the chain...</span>
        ) : vault.error ? (
          <span className="text-[var(--danger)]">Could not read your vault: {vault.error}</span>
        ) : authorised && vault.data ? (
          <div className="flex justify-between gap-3">
            <span className="text-[var(--success)]">Operator {address?.slice(0, 6)}...{address?.slice(-4)}: buyer agent authorised</span>
            <span className="num">{usdc(vault.data.available)} USDC available</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[var(--warn)]">This wallet has not authorised the buyer agent (or the policy is paused or expired). Set up your own vault budget first.</span>
            <button type="button" className="btn btn-ghost !min-h-[36px]" onClick={onOpenVault}>
              Open vault setup
            </button>
          </div>
        )}
      </div>

      <fieldset className="mt-4 space-y-2">
        <legend className="label mb-1">Scenario</legend>
        {SCENARIOS.map((s) => (
          <label key={s.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${scenario === s.id ? 'border-[var(--accent)] bg-white/5' : 'border-white/10'}`}>
            <input type="radio" name="scenario" className="mt-1 !min-h-0 !w-auto" checked={scenario === s.id} onChange={() => setScenario(s.id)} />
            <span>
              <span className="flex items-center gap-2 text-sm font-semibold">
                {s.title} {s.sim ? <SimBadge /> : null}
              </span>
              <span className="block text-xs text-[var(--subtle)]">{s.body}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">Max budget (USDC)</span>
          <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="num mt-1" aria-invalid={!!budgetBad || overBudget} />
        </label>
        <label className="block">
          <span className="label">Deadline</span>
          <select value={minutes} onChange={(e) => setMinutes(e.target.value)} className="mt-1">
            {['15', '30', '60', '120'].map((v) => (
              <option key={v} value={v}>
                {v} minutes
              </option>
            ))}
          </select>
        </label>
      </div>
      {scenario === 'custom' ? <label className="mt-3 block"><span className="label">Public bidding window</span><select value={quoteWindow} onChange={(e) => setQuoteWindow(e.target.value)} className="mt-1"><option value="90">90 seconds</option><option value="120">2 minutes</option><option value="300">5 minutes</option></select></label> : null}
      {budgetBad ? <p className="mt-1 text-xs text-[var(--danger)]">{budgetBad}</p> : null}
      {overBudget ? <p className="mt-1 text-xs text-[var(--danger)]">Budget exceeds the USDC available in your vault.</p> : null}

      {scenario !== 'dispute' ? <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" className="!min-h-0 !w-auto" checked={secondSource} onChange={(e) => setSecondSource(e.target.checked)} />
        Buy an independently signed reference reading via x402 ({usdc(ov?.referencePriceUsdc)} USDC from a separate Gateway balance)
      </label> : <p className="mt-3 text-xs text-[var(--muted)]">This scenario requires a paid reference source.</p>}
      {(secondSource || scenario === 'dispute') && !ov?.referenceConfigured ? <p className="mt-2 text-xs text-[var(--warn)]">Paid reference service is not configured on the backend yet.</p> : null}
      {(secondSource || scenario === 'dispute') && ov?.referenceConfigured ? <p className="mt-2 text-xs text-[var(--subtle)]">The separate Gateway buyer wallet must hold at least 0.001 USDC before the evidence arrives.</p> : null}

      <div className="mt-4 inset p-3 text-xs text-[var(--muted)]">
        <div className="flex justify-between">
          <span>Verifier fee (fixed)</span>
          <span className="num">{ov ? usdc(ov.verifierFeeUsdc) : '-'} USDC</span>
        </div>
        <div className="flex justify-between gap-3">
          <span>Expected payout to winning provider</span>
          <span className="text-right">set by the winning quote, never above budget minus fee</span>
        </div>
      </div>

      {!ov?.deployed ? <ErrorBox message="Contracts are not deployed for this network." /> : null}
      {sim && ov && !ov.fixtureEnabled ? <ErrorBox message="Simulated fixtures are disabled in this environment." /> : null}
      {err ? <ErrorBox message={err} /> : null}
      <button type="button" className="btn btn-primary mt-4 w-full" disabled={disabled} onClick={() => void submit()}>
        <Send size={16} aria-hidden /> {busy ? 'Waiting for your signature...' : 'Sign and dispatch buyer agent'}
      </button>
    </section>
  )
}
