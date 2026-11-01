// Open agent network: ERC-8004 identity checks, adapter-filtered reputation, directory, trust and invitations.
// Anything onchain is read through `netDeps` so tests can inject fakes. A registry outage never throws out of here:
// it degrades to local escrow history.
import { parseAbi, type Address } from 'viem'
import { publicClient, requireDeployment } from './chain'
import { HttpError } from './errors'
import { agentDirectory, audit, missions, reliabilityOf } from './store'
import { CHAIN_ID } from './chain'
import { DELIVERY_TAG, blendTrust, matchInvite, parseProfile, registrationDataUri } from '../src/shared/network'
import { erc8004AdapterAbi } from '../src/shared/abis'
import type { AgentRecord, Invite, MissionRecord, TrustBreakdown } from '../src/shared/types'

const identityAbi = parseAbi(['function ownerOf(uint256 agentId) view returns (address)'])
const reputationAbi = parseAbi([
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
])

export interface NetworkDeps {
  ownerOf(agentId: bigint): Promise<Address>
  adapterIdentity(wallet: Address): Promise<{ agentId: bigint; bound: boolean }>
  /** Adapter-filtered ERC-8004 feedback for one agent: count and the exact mean of the feedback values (0..100). */
  reputation(agentId: bigint): Promise<{ count: number; avgValue: number | undefined }>
  nowSec(): number
}

function needAddr<K extends 'identityRegistry' | 'reputationRegistry' | 'adapter'>(k: K): Address {
  const v = requireDeployment()[k]
  if (!v) throw new Error(`deployment is missing ${k}`)
  return v
}

export const liveNetworkDeps: NetworkDeps = {
  ownerOf: (id) => publicClient.readContract({ address: needAddr('identityRegistry'), abi: identityAbi, functionName: 'ownerOf', args: [id] }),
  adapterIdentity: async (wallet) => {
    const [agentId, bound] = await publicClient.readContract({ address: needAddr('adapter'), abi: erc8004AdapterAbi, functionName: 'identityOf', args: [wallet] })
    return { agentId, bound }
  },
  reputation: async (id) => {
    const rep = needAddr('reputationRegistry')
    const clients = [needAddr('adapter')] // trusted client list: only feedback posted by OUR adapter counts
    const [count, summary, decimals] = await publicClient.readContract({ address: rep, abi: reputationAbi, functionName: 'getSummary', args: [id, clients, DELIVERY_TAG, ''] })
    if (count === 0n) return { count: 0, avgValue: undefined }
    try {
      const all = await publicClient.readContract({ address: rep, abi: reputationAbi, functionName: 'readAllFeedback', args: [id, clients, DELIVERY_TAG, '', false] })
      const vals = all[2].map((v, i) => Number(v) / 10 ** all[3][i])
      if (vals.length) return { count: vals.length, avgValue: vals.reduce((a, b) => a + b, 0) / vals.length }
    } catch {
      /* fall through to the summary value */
    }
    return { count: Number(count), avgValue: Number(summary) / 10 ** decimals }
  },
  nowSec: () => Math.floor(Date.now() / 1000),
}

export const netDeps: { current: NetworkDeps } = { current: liveNetworkDeps }
const TTL_MS = 15_000
const identityCache = new Map<string, { at: number; v: IdentityResult }>()
const repCache = new Map<string, { at: number; v: { count: number; avgValue: number | undefined } | { error: string } }>()
export const resetNetworkCaches = () => {
  identityCache.clear()
  repCache.clear()
}

export interface IdentityResult {
  ok: boolean
  reason?: string
  agentId?: string
}

/** Live check: the adapter binds this wallet to an agent id AND the ERC-8004 identity token is owned by the same wallet. */
export async function verifyIdentity(wallet: Address, expectedAgentId?: string, fresh = false): Promise<IdentityResult> {
  const key = `${wallet.toLowerCase()}:${expectedAgentId ?? ''}`
  const hit = identityCache.get(key)
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.v
  let v: IdentityResult
  try {
    const b = await netDeps.current.adapterIdentity(wallet)
    if (!b.bound) v = { ok: false, reason: 'this wallet has not bound an ERC-8004 identity in the marketplace adapter (call bindAgent)' }
    else if (expectedAgentId !== undefined && b.agentId.toString() !== expectedAgentId)
      v = { ok: false, reason: `the adapter binds this wallet to agent #${b.agentId}, not #${expectedAgentId}` }
    else {
      let owner: Address | null = null
      try {
        owner = await netDeps.current.ownerOf(b.agentId)
      } catch {
        owner = null
      }
      v =
        owner === null
          ? { ok: false, reason: `ERC-8004 identity #${b.agentId} does not exist` }
          : owner.toLowerCase() === wallet.toLowerCase()
            ? { ok: true, agentId: b.agentId.toString() }
            : { ok: false, reason: `ERC-8004 identity #${b.agentId} is owned by another wallet (transferred or spoofed binding)` }
    }
  } catch (e) {
    v = { ok: false, reason: `could not read the ERC-8004 registry: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}` }
    return v // transient: do not cache failures
  }
  identityCache.set(key, { at: Date.now(), v })
  return v
}

async function onchainFor(agentId: string) {
  const hit = repCache.get(agentId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v
  let v: { count: number; avgValue: number | undefined } | { error: string }
  try {
    v = await netDeps.current.reputation(BigInt(agentId))
  } catch (e) {
    v = { error: e instanceof Error ? e.message.slice(0, 120) : 'registry unavailable' }
  }
  repCache.set(agentId, { at: Date.now(), v })
  return v
}

/**
 * Trust for a provider wallet: local verified escrow history blended with adapter-filtered ERC-8004 feedback.
 * Onchain reputation is counted only while the wallet's identity checks out RIGHT NOW (owner + adapter binding),
 * is not a directory identity that changed hands, and the registry answers. Otherwise it falls back to local history.
 */
export async function trustFor(wallet: Address, freshIdentity = false): Promise<TrustBreakdown> {
  const local = reliabilityOf(wallet)
  const base = { ok: local.ok, total: local.total }
  const rec = agentDirectory.get(wallet)
  const id = await verifyIdentity(wallet, rec?.agentId, freshIdentity)
  if (!id.ok || !id.agentId) return blendTrust(base, { available: false, count: 0, reason: `No onchain reputation counted: ${id.reason ?? 'no verified ERC-8004 identity'}.` })
  if (rec && rec.ownerHistory.length > 1)
    return blendTrust(base, { available: false, count: 0, agentId: id.agentId, reason: 'This identity changed hands in the directory; inherited reputation is not counted (cold start).' })
  const rep = await onchainFor(id.agentId)
  if ('error' in rep) return blendTrust(base, { available: false, count: 0, agentId: id.agentId, reason: `ERC-8004 reputation registry unavailable (${rep.error}); using local escrow history.` })
  return blendTrust(base, { available: true, count: rep.count, avgValue: rep.avgValue, agentId: id.agentId })
}

// ---------------- directory ----------------

/** Wallet-signed registration or update. The signer IS the wallet; nothing in the body can name another wallet. */
export async function registerAgent(signer: Address, body: unknown): Promise<AgentRecord> {
  const dep = requireDeployment()
  const existing = agentDirectory.get(signer)
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

  if (raw.active === false) {
    if (!existing) throw new HttpError(404, 'this wallet is not in the directory')
    existing.active = false
    existing.updatedAt = Date.now()
    agentDirectory.put(existing)
    return existing
  }

  const parsed = parseProfile(raw)
  if (!parsed.ok) throw new HttpError(400, parsed.error)
  const p = parsed.value
  if (existing && existing.agentId !== p.agentId) throw new HttpError(409, `this wallet is already registered with agent #${existing.agentId}; the identity id cannot be changed (deactivate instead)`)
  const id = await verifyIdentity(signer, p.agentId, true)
  if (!id.ok) throw new HttpError(403, `ERC-8004 identity check failed: ${id.reason}`)

  const ownerHistory: Address[] = existing ? existing.ownerHistory : []
  for (const other of agentDirectory.byAgentId(p.agentId)) {
    if (other.wallet.toLowerCase() === signer.toLowerCase()) continue
    // Another wallet already holds this id in the directory. Only allowed when that record's identity no longer verifies
    // (the token moved). The identity then counts as having changed hands: no inherited onchain reputation.
    const stillOwner = await verifyIdentity(other.wallet, p.agentId, true)
    if (stillOwner.ok) throw new HttpError(409, `agent #${p.agentId} is already registered by ${other.wallet}`)
    other.active = false
    other.supersededBy = signer
    other.identity = { ok: false, reason: 'identity token moved to another wallet', checkedAt: Date.now() }
    agentDirectory.put(other)
    for (const w of other.ownerHistory) if (!ownerHistory.some((x) => x.toLowerCase() === w.toLowerCase())) ownerHistory.push(w)
  }
  if (!ownerHistory.some((x) => x.toLowerCase() === signer.toLowerCase())) ownerHistory.push(signer)

  const now = Date.now()
  const rec: AgentRecord = {
    wallet: signer,
    agentId: p.agentId,
    displayName: p.displayName,
    capability: p.capability,
    minPriceUsdc: p.minPriceUsdc,
    maxPriceUsdc: p.maxPriceUsdc,
    maxEtaSec: p.maxEtaSec,
    cardUrl: p.cardUrl,
    registrationUri: p.cardUrl ?? registrationDataUri({ name: p.displayName, capability: p.capability, chainId: CHAIN_ID, identityRegistry: dep.identityRegistry ?? '', agentId: p.agentId }),
    active: raw.active === undefined ? true : raw.active === true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ownerHistory,
    identity: { ok: true, checkedAt: now },
  }
  agentDirectory.put(rec)
  return rec
}

// ---------------- invitations ----------------

const MAX_INVITES = 8
/** Snapshot of agents recommended for a CUSTOM request. Persisted on the mission; not an allowlist. */
export async function computeInvites(m: MissionRecord): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const entries: Invite[] = []
  const skipped: { wallet: Address; reason: string }[] = []
  const active = agentDirectory.all().filter((a) => a.active)
  const availBudget = BigInt(m.spec.budgetUsdc) - 50_000n // verifier fee reserve; see config.verifierFeeUsdc
  for (const a of active) {
    const id = await verifyIdentity(a.wallet, a.agentId, true)
    a.identity = { ok: id.ok, reason: id.reason, checkedAt: Date.now() }
    if (!id.ok) {
      skipped.push({ wallet: a.wallet, reason: id.reason ?? 'identity not verified' })
      continue
    }
    const trust = await trustFor(a.wallet, true)
    const r = matchInvite(a, { availBudget, secondsLeft: m.spec.deadlineUnix - now }, trust.blended)
    if (!r.eligible) {
      skipped.push({ wallet: a.wallet, reason: r.reasons[0] })
      continue
    }
    entries.push({ wallet: a.wallet, agentId: a.agentId, name: a.displayName, capability: a.capability, score: r.score, trust: trust.blended, reasons: r.reasons })
  }
  agentDirectory.save()
  entries.sort((x, y) => y.score - x.score)
  m.invites = { at: Date.now(), entries: entries.slice(0, MAX_INVITES), considered: active.length, skipped: skipped.slice(0, 20) }
  missions.save()
  audit(m, 'system', `Discovery: ${entries.length} of ${active.length} active registered agents matched this request; invited ${Math.min(entries.length, MAX_INVITES)}. Any signed quote may still bid.`, 'info', { invited: entries.slice(0, MAX_INVITES).map((e) => e.wallet) })
}

/** Open requests visible to a wallet's runner. `invited` marks recommendations; `open=true` also lists uninvited requests. */
export function invitesFor(wallet: string, includeOpen: boolean) {
  const now = Math.floor(Date.now() / 1000)
  const out: { missionId: string; tile: string; onchainSpec: MissionRecord['spec']; specHash: string; budgetUsdc: string; quoteDeadlineUnix: number; invited: boolean; invite?: Invite; alreadyQuoted: boolean }[] = []
  for (const m of missions.all()) {
    if (m.stage !== 'quoting' || !m.quoteDeadlineUnix || now >= m.quoteDeadlineUnix) continue
    const invite = m.invites?.entries.find((e) => e.wallet.toLowerCase() === wallet.toLowerCase())
    if (!invite && !includeOpen) continue
    out.push({
      missionId: m.id, tile: m.spec.tile, onchainSpec: m.spec, specHash: m.specHash, budgetUsdc: m.spec.budgetUsdc,
      quoteDeadlineUnix: m.quoteDeadlineUnix, invited: !!invite, invite, alreadyQuoted: m.quotes.some((q) => q.provider.toLowerCase() === wallet.toLowerCase()),
    })
  }
  return out
}

// ---------------- read views ----------------

export async function agentView(a: AgentRecord) {
  const id = await verifyIdentity(a.wallet, a.agentId)
  const trust = await trustFor(a.wallet)
  const all = missions.all()
  const mine = all.filter((m) => m.chain?.provider.toLowerCase() === a.wallet.toLowerCase())
  const invited = all.filter((m) => m.invites?.entries.some((e) => e.wallet.toLowerCase() === a.wallet.toLowerCase()))
  const quoted = all.filter((m) => m.quotes.some((q) => q.provider.toLowerCase() === a.wallet.toLowerCase()))
  const settled = mine.filter((m) => m.stage === 'settled' || m.stage === 'expired')
  return {
    ...a,
    identity: { ok: id.ok, reason: id.reason, checkedAt: Date.now() },
    trust,
    activity: {
      invited: invited.length,
      quoted: quoted.length,
      won: mine.length,
      settled: settled.length,
      paid: settled.filter((m) => m.chainOutcome === 1 || (m.chainOutcome === undefined && m.verdict?.decision === 'accept' && m.stage === 'settled')).length,
    },
    recent: mine.slice(0, 8).map((m) => ({ missionId: m.id, onchainId: m.chain?.onchainId, tile: m.spec.tile, stage: m.stage, feedback: m.feedback })),
  }
}
