import { account, config, hasRole, NETWORK, PUBLIC_READ_ONLY, roleAddresses, type Role } from './env'
import {
  CHAIN_ID,
  deployment,
  escrowEvents,
  escrowRead,
  explorerBase,
  publicClient,
  readMission,
  requireDeployment,
  usdcAddress,
  usdcBalance,
  vaultRead,
} from './chain'
import { agentDirectory, getEvidence, missions } from './store'
import { PROVIDERS } from './agents/provider'
import { hashCanonical } from '../src/shared/canonical'
import { OUTCOME_NAMES, STATUS_NAMES, tileIdOf } from '../src/shared/typed'
import type { MissionRecord } from '../src/shared/types'
import type { Address } from 'viem'
import { same, type AuthzDeps, type PolicyView } from './authz'
import { referenceConfig, REFERENCE_PRICE_USDC } from './second-source'

export const TILE_ROWS = [1, 2, 3, 4]
export const TILE_COLS = ['A', 'B', 'C', 'D', 'E', 'F']

export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as unknown
}

async function onchainSnapshot(m: MissionRecord) {
  if (!m.chain) return null
  const on = await readMission(BigInt(m.chain.onchainId))
  return {
    status: STATUS_NAMES[on.status] ?? String(on.status),
    outcome: OUTCOME_NAMES[on.outcome] ?? String(on.outcome),
    decision: ['None', 'Accept', 'Reject', 'Escalate'][on.decision],
    deadline: Number(on.deadline),
    createdAt: Number(on.createdAt),
    submittedAt: Number(on.submittedAt),
    challengeEndsAt: Number(on.challengeEndsAt),
    challengedAt: Number(on.challengedAt),
    evidenceHash: on.evidenceHash,
    readingCommitment: on.readingCommitment,
    verdictReasonHash: on.verdictReasonHash,
    providerPrice: on.providerPrice,
    verifierFee: on.verifierFee,
  }
}

/** Public view of a mission. Private evidence body (raw payload, notes, serials) is never included. */
export async function publicMission(m: MissionRecord) {
  const bundle = m.evidenceHash ? getEvidence(m.evidenceHash) : null
  const { observation, ...rest } = m
  return jsonSafe({
    ...rest,
    observation: observation
      ? { kind: observation.kind, reading: observation.reading, simulated: observation.kind === 'simulated-fixture' }
      : undefined,
    onchain: await onchainSnapshot(m).catch(() => null),
    evidencePreview: bundle,
  })
}

const ROLE_LABELS: Record<string, string> = {
  operator: 'Operator (demo key, server-held)',
  buyer: 'Buyer agent (vault executor)',
  providerA: 'Provider A: Signal Data Agent',
  providerB: 'Provider B: Atlas Data Agent',
  verifier: 'Verifier agent',
  arbiter: 'Human arbiter (demo key, server-held)',
}

export async function overview() {
  const dep = deployment
  const addrs = roleAddresses()
  const wallets = await Promise.all(
    (Object.keys(ROLE_LABELS) as Role[])
      .filter((r) => addrs[r])
      .map(async (r) => ({ role: r, label: ROLE_LABELS[r], address: addrs[r] as Address, usdc: (await usdcBalance(addrs[r] as Address).catch(() => 0n)).toString() })),
  )
  let vault: unknown = null
  let escrow: unknown = null
  const publicOperator = process.env.FQ_PUBLIC_OPERATOR_ADDRESS
  if (dep && (hasRole('operator') || (PUBLIC_READ_ONLY && publicOperator))) {
    const op = hasRole('operator') ? account('operator').address : publicOperator as Address
    try {
      const [policy, available, committed, net] = await Promise.all([
        vaultRead('policyOf', [op]),
        vaultRead<bigint>('availableOf', [op]),
        vaultRead<bigint>('committedOf', [op]),
        vaultRead<bigint>('netSpentOf', [op]),
      ])
      vault = { operator: op, policy, available, committed, netSpent: net }
      escrow = {
        liabilities: await escrowRead<bigint>('totalLiabilities'),
        usdcHeld: await usdcBalance(dep.escrow),
      }
    } catch {
      /* chain read failed; UI shows unavailable */
    }
  }
  return jsonSafe({
    network: NETWORK,
    readOnly: PUBLIC_READ_ONLY,
    chainId: CHAIN_ID,
    explorer: explorerBase,
    usdc: usdcAddress,
    deployed: !!dep,
    contracts: dep ? { registry: dep.registry, escrow: dep.escrow, vault: dep.vault, adapter: dep.adapter, deployTxs: dep.deployTxs } : null,
    fork: !!process.env.FQ_RPC_URL_OVERRIDE,
    arbiter: await escrowRead<Address>('arbiter').catch(() => null),
    buyerAgent: hasRole('buyer') ? account('buyer').address : PUBLIC_READ_ONLY ? process.env.FQ_PUBLIC_BUYER_ADDRESS ?? null : null,
    fixtureEnabled: config.fixtureEnabled,
    llmConfigured: !!config.llmKey,
    referenceConfigured: !!referenceConfig(),
    referencePriceUsdc: REFERENCE_PRICE_USDC.toString(),
    block: (await publicClient.getBlockNumber().catch(() => 0n)).toString(),
    wallets,
    vault,
    escrow,
    providers: PROVIDERS.map((p) => ({ role: p.role, name: p.name, capability: p.capability, address: hasRole(p.role) ? account(p.role).address : null })),
    verifierFeeUsdc: config.verifierFeeUsdc,
  })
}

export async function tiles() {
  const all = missions.all()
  const grid = []
  for (const row of TILE_ROWS) {
    for (const col of TILE_COLS) {
      const tile = `${col}${row}`
      const latest = all.find((m) => m.spec.tile === tile)
      let state: 'fog' | 'active' | 'revealed' | 'rejected' | 'expired' | 'blocked' = 'fog'
      let value: number | undefined
      let simulated: boolean | undefined
      if (latest) {
        const b = latest.evidenceHash ? getEvidence(latest.evidenceHash) : null
        if (latest.stage === 'blocked' || latest.stage === 'failed') state = 'blocked'
        else if (latest.stage === 'expired') state = 'expired'
        else if (latest.stage === 'settled') {
          const on = await onchainSnapshot(latest).catch(() => null)
          state = on?.outcome === 'ProviderPaid' ? 'revealed' : 'rejected'
        } else state = 'active'
        if (b && (state === 'revealed' || latest.stage === 'evidence_submitted' || latest.stage === 'challenge_window')) {
          value = Number(b.reading.value)
          simulated = b.provenance.simulated
        }
      }
      grid.push({ tile, col, row, state, missionId: latest?.id, value, simulated,
        bidCount: latest?.quotes.length ?? 0, budgetUsdc: latest?.spec.budgetUsdc,
        quoteDeadlineUnix: latest?.stage === 'quoting' ? latest.quoteDeadlineUnix : undefined })
    }
  }
  return grid
}

const receiptCache = new Map<string, { at: number; value: unknown }>()

/** Receipts are rebuilt from chain events. Cache briefly and serve the last good copy if the RPC is rate limiting. */
export async function receipt(ref: string) {
  const hit = receiptCache.get(ref)
  if (hit && Date.now() - hit.at < 20_000) return hit.value
  try {
    const value = await buildReceipt(ref)
    if (value) receiptCache.set(ref, { at: Date.now(), value })
    return value
  } catch (e) {
    if (hit) return hit.value
    throw e
  }
}

async function buildReceipt(ref: string) {
  const local = missions.get(ref) ?? missions.byOnchainId(ref)
  const onchainId = local?.chain?.onchainId ?? (/^\d+$/.test(ref) ? ref : null)
  if (!onchainId) return null
  const dep = requireDeployment()
  const id = BigInt(onchainId)
  const m = await readMission(id)
  if (m.status === 0) return null
  const fromBlock = local?.chain ? BigInt(local.chain.createdBlock) : 0n
  let start = fromBlock
  if (start === 0n) {
    const tx = dep.deployTxs?.MissionEscrow
    start = tx ? (await publicClient.getTransactionReceipt({ hash: tx })).blockNumber : 0n
  }
  const allEvents = await escrowEvents(start)
  // Withdrawn is account-level, with no mission id. A verifier can withdraw
  // credits from several missions, so include it only when this mission's
  // persisted transaction record proves the link. Chain-only receipts omit it.
  const withdrawalTxs = new Set(
    (local?.txs ?? []).filter((t) => t.label.includes('withdraws credited USDC')).map((t) => t.hash.toLowerCase()),
  )
  const mine = allEvents.filter(
    (e) => e.args.id === id || (e.eventName === 'Withdrawn' && withdrawalTxs.has(e.transactionHash.toLowerCase())),
  )
  const events = mine.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex)
  const evidence = getEvidence(m.evidenceHash)
  const evidenceHashMatches = evidence ? hashCanonical(evidence).toLowerCase() === m.evidenceHash.toLowerCase() : null
  const settled = events.find((e) => e.eventName === 'MissionSettled' || e.eventName === 'MissionExpired')
  const tile = TILE_COLS.flatMap((col) => TILE_ROWS.map((row) => `${col}${row}`)).find(
    (candidate) => tileIdOf(candidate).toLowerCase() === m.tileId.toLowerCase(),
  ) ?? null
  return jsonSafe({
    onchainId,
    tile,
    network: NETWORK,
    chainId: CHAIN_ID,
    explorer: explorerBase,
    escrow: dep.escrow,
    registry: dep.registry,
    status: STATUS_NAMES[m.status],
    outcome: OUTCOME_NAMES[m.outcome],
    mission: {
      provider: m.provider,
      verifier: m.verifier,
      buyer: m.buyer,
      providerPrice: m.providerPrice,
      verifierFee: m.verifierFee,
      deadline: Number(m.deadline),
      objectiveHash: m.objectiveHash,
      tileId: m.tileId,
      evidenceHash: m.evidenceHash,
      readingCommitment: m.readingCommitment,
      verdictReasonHash: m.verdictReasonHash,
    },
    spec: local?.spec ?? null,
    specHashMatches: local ? local.specHash.toLowerCase() === m.objectiveHash.toLowerCase() : null,
    evidence,
    evidenceHashMatchesOnchain: evidenceHashMatches,
    verdict: local?.verdict ? { decision: local.verdict.decision, reasons: local.verdict.reasons, reasonHash: local.verdict.reasonHash } : null,
    secondSource: local?.secondSource ?? null,
    settlement: settled ? settled.args : null,
    // Present only when an adapter transaction was actually confirmed (or skipped with a stated reason).
    feedback: local?.feedback ?? null,
    providerAgent: (() => {
      const a = agentDirectory.get(m.provider)
      return a ? { agentId: a.agentId, displayName: a.displayName } : null
    })(),
    invitedProvider: local?.invites ? local.invites.entries.some((e) => e.wallet.toLowerCase() === m.provider.toLowerCase()) : null,
    events: events.map((e) => ({ name: e.eventName, args: e.args, txHash: e.transactionHash, block: e.blockNumber })),
    simulated: evidence?.provenance.simulated ?? null,
  })
}

/** Public read: any operator's vault budget and whether they have authorised THIS buyer agent. */
export async function vaultFor(operator: Address, deps: AuthzDeps) {
  const [policy, available, committed, netSpent] = await Promise.all([
    vaultRead<PolicyView & { perMissionCap: bigint; totalCap: bigint; dailyCap: bigint }>('policyOf', [operator]),
    vaultRead<bigint>('availableOf', [operator]),
    vaultRead<bigint>('committedOf', [operator]),
    vaultRead<bigint>('netSpentOf', [operator]),
  ])
  const buyer = deps.buyerAgent()
  const authorised = !!buyer && same(policy.executor, buyer) && !policy.paused && BigInt(deps.nowSec()) <= policy.expiry
  return jsonSafe({ operator, policy, available, committed, netSpent, buyerAgent: buyer, authorised })
}
