// ERC-8004 outcome feedback. After a mission reaches a final escrow state a keeper job calls the marketplace adapter's
// permissionless recordOutcome(missionId) at most once per role, then records only what the receipt's logs prove.
// A registry failure is reported as FAILED and is never claimed as feedback. It never blocks reconcile, withdrawals
// or refunds: this runs in its own job, after them, and its failure is tolerated.
import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from 'viem'
import { publicClient, readMission, requireDeployment, send, waitForHash } from './chain'
import { audit, feedbackFrom } from './store'
import { recordTx } from './agents/common'
import { erc8004AdapterAbi } from '../src/shared/abis'
import type { FeedbackRecord, MissionRecord } from '../src/shared/types'

export interface FeedbackDeps {
  identityOf(wallet: Address): Promise<{ agentId: bigint; bound: boolean }>
  recorded(role: 'provider' | 'verifier', missionId: bigint): Promise<boolean>
  verdictDelivered(missionId: bigint): Promise<boolean>
  /** Sends adapter.recordOutcome from a funded keeper wallet; resolves once the receipt is confirmed. */
  record(missionId: bigint, onHash: (h: Hex) => void): Promise<{ hash: Hex; receipt: TransactionReceipt }>
  wait(hash: Hex): Promise<TransactionReceipt>
  adapter(): Address
}

const adapterAddr = () => {
  const a = requireDeployment().adapter
  if (!a) throw new Error('deployment has no adapter')
  return a
}

export const liveFeedbackDeps: FeedbackDeps = {
  identityOf: async (wallet) => {
    const [agentId, bound] = await publicClient.readContract({ address: adapterAddr(), abi: erc8004AdapterAbi, functionName: 'identityOf', args: [wallet] })
    return { agentId, bound }
  },
  recorded: (role, id) =>
    publicClient.readContract({ address: adapterAddr(), abi: erc8004AdapterAbi, functionName: role === 'provider' ? 'providerRecorded' : 'verifierRecorded', args: [id] }),
  verdictDelivered: async (id) => (await readMission(id)).decision !== 0,
  record: (id, onHash) => send('verifier', { address: adapterAddr(), abi: erc8004AdapterAbi, functionName: 'recordOutcome', args: [id] }, { onHash }),
  wait: waitForHash,
  adapter: adapterAddr,
}
export const feedbackDeps: { current: FeedbackDeps } = { current: liveFeedbackDeps }

/** Missions that existed before this feature shipped are never back-filled automatically. */
export const feedbackEnabledFor = (m: MissionRecord) => m.createdAt >= feedbackFrom()

export function parseFeedbackLogs(receipt: TransactionReceipt, adapter: Address): FeedbackRecord['entries'] {
  const out: FeedbackRecord['entries'] = []
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== adapter.toLowerCase()) continue
    try {
      const ev = decodeEventLog({ abi: erc8004AdapterAbi, data: l.data, topics: l.topics })
      if (ev.eventName === 'FeedbackRecorded') out.push({ role: ev.args.role === 0 ? 'provider' : 'verifier', agentId: ev.args.agentId.toString(), outcome: 'recorded', value: ev.args.value.toString() })
      else if (ev.eventName === 'FeedbackFailed') out.push({ role: ev.args.role === 0 ? 'provider' : 'verifier', agentId: ev.args.agentId.toString(), outcome: 'failed' })
    } catch {
      /* unrelated log */
    }
  }
  return out
}

export async function recordFeedback(m: MissionRecord, setHash: (h: Hex) => void, resumeHash?: Hex): Promise<void> {
  if (!m.chain) return
  if (m.feedback && (m.feedback.status === 'recorded' || m.feedback.status === 'skipped')) return
  const d = feedbackDeps.current
  const id = BigInt(m.chain.onchainId)
  const [pb, vb] = await Promise.all([d.identityOf(m.chain.provider), d.identityOf(m.chain.verifier)])
  const delivered = vb.bound && (await d.verdictDelivered(id))
  if (!pb.bound && !delivered) {
    m.feedback = { status: 'skipped', at: Date.now(), reason: 'neither the provider nor the verifier has a bound ERC-8004 identity', entries: [] }
    audit(m, 'keeper', 'No ERC-8004 feedback recorded: no bound agent identity for this mission', 'info')
    return
  }
  const [pr, vr] = await Promise.all([pb.bound ? d.recorded('provider', id) : true, delivered ? d.recorded('verifier', id) : true])
  if (pr && vr && !resumeHash) {
    // Everything bound was already recorded by an earlier transaction; claim only what the adapter's flags prove.
    m.feedback = {
      ...m.feedback, status: 'recorded', at: Date.now(), reason: 'adapter flags show feedback was already recorded by an earlier transaction',
      entries: [
        ...(pb.bound ? [{ role: 'provider' as const, agentId: pb.agentId.toString(), outcome: 'recorded' as const, value: m.feedback?.entries.find((e) => e.role === 'provider' && e.outcome === 'recorded')?.value }] : []),
        ...(delivered ? [{ role: 'verifier' as const, agentId: vb.agentId.toString(), outcome: 'recorded' as const, value: m.feedback?.entries.find((e) => e.role === 'verifier' && e.outcome === 'recorded')?.value }] : []),
      ],
    }
    return
  }
  const { hash, receipt } = resumeHash ? { hash: resumeHash, receipt: await d.wait(resumeHash) } : await d.record(id, setHash)
  const latest = parseFeedbackLogs(receipt, d.adapter())
  const entries = [...(m.feedback?.entries.filter((e) => e.outcome === 'recorded') ?? [])]
  for (const entry of latest) {
    const index = entries.findIndex((e) => e.role === entry.role)
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
  }
  const ok = entries.filter((e) => e.outcome === 'recorded').length
  const expected = Number(pb.bound) + Number(delivered)
  const status: FeedbackRecord['status'] = ok === expected ? 'recorded' : ok === 0 ? 'failed' : 'partial'
  m.feedback = { status, at: Date.now(), txHash: hash, txHashes: [...new Set([...(m.feedback?.txHashes ?? (m.feedback?.txHash ? [m.feedback.txHash] : [])), hash])], entries,
    ...(status !== 'recorded' ? { reason: `the ERC-8004 registry did not accept ${expected - ok} feedback role(s) (the escrow outcome is unaffected)` } : {}) }
  try {
    recordTx(m, 'ERC-8004 outcome feedback via marketplace adapter', hash, 'verifier', receipt)
  } catch {
    /* tx bookkeeping needs the keeper key; the feedback record above already carries the hash */
  }
  audit(m, 'keeper', status === 'recorded' ? `ERC-8004 feedback confirmed for ${entries.length} role(s)` : `ERC-8004 feedback ${status}: not claimed as reputation`, status === 'recorded' ? 'info' : 'warn', { txHash: hash })
}
