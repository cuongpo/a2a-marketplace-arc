import type { Hex, TransactionReceipt } from 'viem'
import { decodeEventLog } from 'viem'
import { account, type Role } from '../env'
import { audit } from '../store'
import { missionEscrowAbi } from '../../src/shared/abis'
import type { MissionRecord } from '../../src/shared/types'

export const S = {
  None: 0,
  Funded: 1,
  Assigned: 2,
  Submitted: 3,
  Accepted: 4,
  Rejected: 5,
  Challenged: 6,
  Expired: 7,
  Settled: 8,
} as const

export function recordTx(m: MissionRecord, label: string, hash: Hex, from: Role, receipt?: TransactionReceipt) {
  const existing = m.txs.find((t) => t.hash === hash)
  if (existing) {
    if (receipt) {
      existing.status = receipt.status === 'success' ? 'success' : 'reverted'
      existing.blockNumber = receipt.blockNumber.toString()
    }
    return
  }
  m.txs.push({
    label,
    hash,
    from: account(from).address,
    status: receipt ? (receipt.status === 'success' ? 'success' : 'reverted') : 'pending',
    blockNumber: receipt?.blockNumber.toString(),
    at: Date.now(),
  })
}

export function logTx(m: MissionRecord, agent: Parameters<typeof audit>[1], message: string, hash: Hex) {
  audit(m, agent, message, 'info', { txHash: hash })
}

export function decodeEscrowLogs(receipt: TransactionReceipt, escrow: string) {
  const out: { eventName: string; args: Record<string, unknown> }[] = []
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== escrow.toLowerCase()) continue
    try {
      const ev = decodeEventLog({ abi: missionEscrowAbi, data: l.data, topics: l.topics })
      out.push({ eventName: ev.eventName, args: ev.args as unknown as Record<string, unknown> })
    } catch {
      /* not an escrow event */
    }
  }
  return out
}

export class ObservationRejected extends Error {}
