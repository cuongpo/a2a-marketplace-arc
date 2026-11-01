import { useEffect, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { FlaskConical, Gavel, Lock, Scale, Upload } from 'lucide-react'
import type { Address } from 'viem'
import { short, type Overview, type PMission } from '@/lib/api'
import { useRoles, useSignedPost } from '@/lib/auth'
import { agentBudgetVaultAbi } from '@/shared/abis'
import { ErrorBox, TxLink } from './ui'

function useNow(ms = 1000) {
  const [n, setN] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setN(Math.floor(Date.now() / 1000)), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}
export const fmtLeft = (s: number) => (s <= 0 ? '0s' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`)

function RoleHint({ who, expected, connected, address }: { who: string; expected: string | null | undefined; connected: boolean; address?: string }) {
  return (
    <p className="flex items-start gap-2 text-xs text-[var(--warn)]" role="note">
      <Lock size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        {!connected
          ? `Read-only. Only the ${who} wallet ${expected ? short(expected, 8, 6) : ''} can do this. Connect it to continue.`
          : `You are connected as ${short(address ?? '', 8, 6)}. Only the ${who} wallet ${expected ? short(expected, 8, 6) : ''} can do this.`}
      </span>
    </p>
  )
}

export function ActionPanel({ m, ov, onChange }: { m: PMission; ov: Overview | null; onChange: () => void }) {
  const now = useNow()
  const signedPost = useSignedPost()
  const roles = useRoles(m, ov)
  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const activeChainId = m.chain?.chainId ?? ov?.chainId
  const publicClient = usePublicClient({ chainId: activeChainId })
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [chHash, setChHash] = useState<string | null>(null)
  const [variant, setVariant] = useState<'valid' | 'implausible' | 'ambiguous'>(m.scenario === 'reject' ? 'implausible' : m.scenario === 'dispute' ? 'ambiguous' : 'valid')
  const [json, setJson] = useState('')
  const st = m.onchain?.status
  const externalProvider = !!m.decision?.scored.find((s) => s.quote.quoteId === m.decision?.chosenQuoteId && !s.quote.simulated)

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setErr(null)
    try {
      await fn()
      onChange()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusy(null)
    }
  }

  /** The operator challenges from their own wallet: a real vault transaction, not a server call. */
  async function challenge() {
    if (!ov?.contracts || !m.chain) throw new Error('Contracts are not available')
    if (!activeChainId) throw new Error('The mission chain is unknown')
    if (chainId !== activeChainId) await switchChainAsync({ chainId: activeChainId })
    const hash = await writeContractAsync({
      address: ov.contracts.vault as Address,
      abi: agentBudgetVaultAbi,
      functionName: 'challengeMission',
      args: [ov.contracts.escrow as Address, BigInt(m.chain.onchainId)],
      chainId: activeChainId,
    })
    setChHash(hash)
    const receipt = await publicClient?.waitForTransactionReceipt({ hash })
    if (receipt && receipt.status !== 'success') throw new Error('The challenge transaction reverted')
  }

  const needsObs = st === 'Assigned' && !m.observation
  const queued = (st === 'Assigned' || st === 'Funded') && !!m.observation
  const canProvide = roles.isProvider

  return (
    <div className="space-y-3">
      {needsObs ? (
        <div className="inset space-y-3 p-3">
          <div className="label">Provide the observation</div>
          {m.autoFixture ? (
            <p className="text-xs text-[var(--muted)]">The operator enabled the SIMULATED fixture for this mission, so the provider agent feeds it automatically.</p>
          ) : null}
          {!canProvide ? <RoleHint who="bound provider" expected={m.chain?.provider} connected={roles.connected} address={roles.address} /> : null}
          {ov?.fixtureEnabled && !m.autoFixture && !externalProvider ? (
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Fixture variant" value={variant} disabled={!canProvide} onChange={(e) => setVariant(e.target.value as typeof variant)} className="!w-auto">
                <option value="valid">valid reading</option>
                <option value="implausible">implausible reading (will be rejected)</option>
                <option value="ambiguous">ambiguous reading (will escalate)</option>
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || !canProvide}
                onClick={() => void run('fx', () => signedPost(`/missions/${m.id}/fixture`, { variant }))}
              >
                <FlaskConical size={16} aria-hidden /> {busy === 'fx' ? 'Waiting for signature...' : 'Sign and feed SIMULATED fixture'}
              </button>
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="obs">
              Or paste a signed reading JSON from your registered signer or device adapter
            </label>
            <textarea
              id="obs"
              className="mono mt-1 text-xs"
              value={json}
              disabled={!canProvide}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"reading": {...}, "signature": "0x...", "rawPayload": {...}, "kind": "field-operator-upload"}'
            />
            <button
              type="button"
              className="btn btn-ghost mt-2"
              disabled={busy !== null || !json.trim() || !canProvide}
              onClick={() =>
                void run('up', async () => {
                  let body: unknown
                  try {
                    body = JSON.parse(json)
                  } catch {
                    throw new Error('That is not valid JSON')
                  }
                  await signedPost(`/missions/${m.id}/observation`, body)
                  setJson('')
                })
              }
            >
              <Upload size={16} aria-hidden /> {busy === 'up' ? 'Waiting for signature...' : 'Sign and submit reading'}
            </button>
            <p className="mt-1 text-[11px] text-[var(--subtle)]">
              Two signatures exist: the provider wallet authorises this upload, and the registered device key signs the reading itself. Generate a device-signed reading offline with{' '}
              <span className="mono">bun run scripts/sign-reading.ts</span>.
            </p>
          </div>
        </div>
      ) : null}

      {queued ? <p className="text-sm text-[var(--muted)]">{externalProvider ? 'Evidence prepared. The winning provider wallet must commit its hash onchain.' : 'Observation queued. The provider agent validates it against the registry before submitting its hash.'}</p> : null}

      {st === 'Accepted' ? (
        <div className="inset space-y-2 p-3">
          <div className="label">Challenge window</div>
          <p className="text-sm text-[var(--muted)]">
            Verdict recorded: accept. Payout is credited when the window closes{m.onchain ? ` (in ${fmtLeft(m.onchain.challengeEndsAt - now)})` : ''}. Challenging sends it to the human arbiter.
          </p>
          {!roles.isOperator ? <RoleHint who="mission operator" expected={m.operator} connected={roles.connected} address={roles.address} /> : null}
          <button type="button" className="btn btn-danger" disabled={busy !== null || !roles.isOperator} onClick={() => void run('ch', challenge)}>
            <Gavel size={16} aria-hidden /> {busy === 'ch' ? 'Confirm in wallet...' : 'Challenge from my wallet (sends a transaction)'}
          </button>
          {chHash && ov ? (
            <p className="text-xs text-[var(--muted)]">
              Challenge submitted: <TxLink chainId={ov.chainId} hash={chHash} />
            </p>
          ) : null}
        </div>
      ) : null}

      {st === 'Challenged' ? (
        <div className="inset space-y-2 p-3">
          <div className="label">Human dispute review</div>
          <p className="text-sm text-[var(--muted)] text-pretty">
            The evidence is ambiguous or challenged. The system does not claim to know the physical truth. A human arbiter rules; on arbiter silence the signed verifier verdict stands, or the buyer is
            refunded if there is none.
          </p>
          {ov?.network === 'mainnet' ? <p className="text-xs text-[var(--muted)]">The separate arbiter wallet resolves mainnet disputes directly on the escrow contract.</p> : !roles.isArbiter ? <RoleHint who="arbiter" expected={ov?.arbiter} connected={roles.connected} address={roles.address} /> : null}
          {ov?.network !== 'mainnet' ? <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={busy !== null || !roles.isArbiter} onClick={() => void run('arb1', () => signedPost(`/missions/${m.id}/arbiter`, { providerWins: true }))}>
              <Scale size={16} aria-hidden /> Sign: rule for provider
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy !== null || !roles.isArbiter} onClick={() => void run('arb2', () => signedPost(`/missions/${m.id}/arbiter`, { providerWins: false }))}>
              <Scale size={16} aria-hidden /> Sign: rule for buyer
            </button>
          </div> : null}
          {ov?.network !== 'mainnet' ? <p className="text-[11px] text-[var(--subtle)]">Testnet demo: the arbiter wallet is a demo key. In production the arbiter is a separate human-controlled wallet.</p> : null}
        </div>
      ) : null}
      {err ? <ErrorBox message={err} /> : null}
    </div>
  )
}
