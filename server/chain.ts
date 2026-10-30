import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { account, assertTestnetOnlyKeys, loadDeployment, NETWORK, rpcUrlFor, type Deployment, type Role } from './env'
import { agentBudgetVaultAbi, evidenceRegistryAbi, missionEscrowAbi } from '../src/shared/abis'
import { getUsdc, requireChain } from '../src/onchain-facts'

export const deployment: Deployment | null = loadDeployment()

export function requireDeployment(): Deployment {
  if (!deployment) throw new Error(`No ${NETWORK} deployment found in src/deployments. Deploy the contracts first.`)
  return deployment
}

export const CHAIN_ID = NETWORK === 'mainnet' ? 5042 : 5042002
const facts = requireChain(CHAIN_ID)

export const usdcAddress: Address = getAddress(getUsdc(CHAIN_ID)?.address ?? '')
export const explorerBase = facts.explorerBase

export const arcChain = defineChain({
  id: CHAIN_ID,
  name: facts.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: facts.nativeCurrency.decimals }, // native gas view; app money uses the 6-decimal ERC-20 view
  rpcUrls: { default: { http: [rpcUrlFor(NETWORK === 'mainnet' ? 'Arc' : 'Arc_Testnet', facts.rpcUrls[0])] } },
})

// The public RPC rate limits bursts (JSON-RPC -32005). Retry with exponential backoff instead of failing a step.
const transport = () => http(undefined, { retryCount: 6, retryDelay: 700, timeout: 20_000 })
export const publicClient = createPublicClient({ chain: arcChain, transport: transport() })

const wallets = new Map<Role, ReturnType<typeof createWalletClient>>()
function walletClient(role: Role) {
  assertTestnetOnlyKeys()
  let w = wallets.get(role)
  if (!w) {
    w = createWalletClient({ account: account(role), chain: arcChain, transport: transport() })
    wallets.set(role, w)
  }
  return w
}

export interface ContractReq {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

// One in-flight transaction per signer so nonces never collide.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

export function errMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { shortMessage?: string; message?: string; details?: string }
    return (o.shortMessage ?? o.details ?? o.message ?? 'unknown error').slice(0, 400)
  }
  return String(e).slice(0, 400)
}

/**
 * Simulate, sign (server-side key), broadcast and WAIT for the receipt. A reverted receipt throws:
 * nothing in the app is ever treated as "paid" until a successful receipt exists.
 */
export async function send(
  role: Role,
  req: ContractReq,
  opts: { onHash?: (hash: Hex) => void } = {},
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  return serial(role, async () => {
    const acct = account(role)
    const { request } = await publicClient.simulateContract({ ...req, account: acct })
    const hash = await walletClient(role).writeContract(request)
    opts.onHash?.(hash)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 })
    if (receipt.status !== 'success') throw new Error(`transaction reverted onchain: ${hash}`)
    return { hash, receipt }
  })
}

export async function waitForHash(hash: Hex): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`transaction reverted onchain: ${hash}`)
  return receipt
}

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 's', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'o', type: 'address' },
      { name: 's', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi

/** ERC-20 view of USDC (6 decimals). Never the 18-decimal native view. */
export async function usdcBalance(addr: Address): Promise<bigint> {
  return publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [addr] })
}

export interface OnchainMission {
  buyer: Address
  refundTo: Address
  provider: Address
  verifier: Address
  providerPrice: bigint
  verifierFee: bigint
  createdAt: bigint
  deadline: bigint
  assignedAt: bigint
  submittedAt: bigint
  verdictAt: bigint
  challengeEndsAt: bigint
  challengedAt: bigint
  maxReadingAge: number
  challengeWindow: number
  status: number
  outcome: number
  decision: number
  objectiveHash: Hex
  tileId: Hex
  unit: Hex
  quoteHash: Hex
  evidenceHash: Hex
  readingCommitment: Hex
  verdictReasonHash: Hex
}

export async function readMission(id: bigint): Promise<OnchainMission> {
  return await publicClient.readContract({
    address: requireDeployment().escrow,
    abi: missionEscrowAbi,
    functionName: 'getMission',
    args: [id],
  })
}

export async function nowChainSec(): Promise<number> {
  const b = await publicClient.getBlock()
  return Number(b.timestamp)
}

const escrowAbi: Abi = missionEscrowAbi
const vaultAbi: Abi = agentBudgetVaultAbi
const registryAbi: Abi = evidenceRegistryAbi

export const escrowRead = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
  publicClient.readContract({ address: requireDeployment().escrow, abi: escrowAbi, functionName, args }) as Promise<T>

export const vaultRead = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
  publicClient.readContract({ address: requireDeployment().vault, abi: vaultAbi, functionName, args }) as Promise<T>

export const registryRead = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
  publicClient.readContract({ address: requireDeployment().registry, abi: registryAbi, functionName, args }) as Promise<T>

export const norm = (a: string): Address => getAddress(a)

export interface ChainEvent {
  eventName: string
  args: Record<string, unknown>
  transactionHash: Hex
  blockNumber: bigint
  logIndex: number
}

/**
 * Address-only getLogs, decoded locally. (The RPC rejected viem's multi-topic filter as "range too large",
 * while the same range with an address-only filter succeeds.) Chunked, and a chunk is halved on a range error.
 */
export async function escrowEvents(fromBlock: bigint, missionId?: bigint): Promise<ChainEvent[]> {
  const dep = requireDeployment()
  const latest = await publicClient.getBlockNumber()
  const out: ChainEvent[] = []
  let step = 4_000n
  for (let from = fromBlock; from <= latest; ) {
    const to = from + step - 1n > latest ? latest : from + step - 1n
    let logs
    try {
      logs = await publicClient.getLogs({ address: dep.escrow, fromBlock: from, toBlock: to })
    } catch (e) {
      if (step > 100n && /range/i.test(errMsg(e) + JSON.stringify((e as { details?: string }).details ?? ''))) {
        step /= 2n
        continue
      }
      throw e
    }
    for (const l of logs) {
      let ev
      try {
        ev = decodeEventLog({ abi: missionEscrowAbi, data: l.data, topics: l.topics })
      } catch {
        continue
      }
      const args = (ev.args ?? {}) as unknown as Record<string, unknown>
      if (missionId !== undefined && args.id !== undefined && args.id !== missionId) continue
      out.push({ eventName: ev.eventName, args, transactionHash: l.transactionHash, blockNumber: l.blockNumber, logIndex: l.logIndex })
    }
    from = to + 1n
  }
  return out
}
