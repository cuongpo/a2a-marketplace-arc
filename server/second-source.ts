import { GatewayClient } from '@circle-fin/x402-batching/client'
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { audit, missions } from './store'
import { NETWORK } from './env'
import { hashCanonical } from '../src/shared/canonical'
import type { MissionRecord, SecondSourceRecord } from '../src/shared/types'

export const REFERENCE_PRICE_USDC = 1_000n // $0.001, six decimals
const MAX_AGE_SEC = 1_800

function withTimeout<T>(pending: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${step} timed out; review Gateway before retrying`)), ms) })
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer))
}

export type ReferencePayload = Pick<SecondSourceRecord, 'schema' | 'missionId' | 'tile' | 'valueMm' | 'observedAt' | 'sourceId' | 'provenance'>
type PaidReference = { payload: ReferencePayload; signature: Hex; signer: Address; seller: Address; paid?: { payer?: Address; network?: string; amount?: string; transaction?: string } }

export function referenceConfig() {
  const url = process.env.FQ_REFERENCE_SERVICE_URL?.replace(/\/$/, '')
  const key = process.env.FQ_REFERENCE_BUYER_KEY
  const signer = process.env.FQ_REFERENCE_SIGNER_ADDRESS
  const seller = process.env.FQ_REFERENCE_SELLER_ADDRESS
  if (NETWORK !== 'testnet' || !url || !/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(url) || !key || !/^0x[0-9a-fA-F]{64}$/.test(key) || !signer || !isAddress(signer) || !seller || !isAddress(seller)) return null
  return { url, key: key as Hex, signer: getAddress(signer), seller: getAddress(seller) }
}

/** Checks source identity, mission binding, freshness and the signed payload.
 * This proves which reference operator attested to the value; it does not
 * prove that the physical reading is truthful. */
export async function validateReference(m: MissionRecord, reply: PaidReference, payer: Address, amount: bigint, paymentReference: string): Promise<SecondSourceRecord> {
  const config = referenceConfig()
  if (!config || !m.chain) throw new Error('paid reference service is not configured')
  if (amount !== REFERENCE_PRICE_USDC) throw new Error('reference service charged an unexpected amount')
  const p = reply?.payload
  if (!p || p.schema !== 'a2a.reference/1' || p.missionId !== m.chain.onchainId || p.tile !== m.spec.tile || !Number.isInteger(p.valueMm) || !Number.isInteger(p.observedAt) || !/^[\w .:-]{3,80}$/.test(p.sourceId ?? '') || !['field-operator-upload', 'device-adapter', 'simulated-fixture'].includes(p.provenance)) throw new Error('reference payload does not match this mission')
  const now = Math.floor(Date.now() / 1000)
  if (p.observedAt < m.chain.createdAtChain || p.observedAt > now + 30 || now - p.observedAt > MAX_AGE_SEC) throw new Error('reference reading is stale or predates this mission')
  if (reply.signer?.toLowerCase() !== config.signer.toLowerCase() || reply.seller?.toLowerCase() !== config.seller.toLowerCase()) throw new Error('reference signer or seller is not allowlisted')
  if (reply.signer.toLowerCase() === m.chain.provider.toLowerCase() || reply.seller.toLowerCase() === m.chain.provider.toLowerCase()) throw new Error('reference source is the primary provider')
  const payloadHash = hashCanonical(p)
  const recovered = await recoverMessageAddress({ message: { raw: payloadHash }, signature: reply.signature })
  if (recovered.toLowerCase() !== config.signer.toLowerCase()) throw new Error('reference signature is invalid')
  if (!reply.paid?.payer || reply.paid.payer.toLowerCase() !== payer.toLowerCase()) throw new Error('payment payer mismatch')
  if (reply.paid.network !== 'eip155:5042002') throw new Error('reference was paid on the wrong network')
  if (!reply.paid.amount || BigInt(reply.paid.amount) !== REFERENCE_PRICE_USDC) throw new Error('seller reported an unexpected payment amount')
  if (!paymentReference) throw new Error('Gateway did not provide a payment reference')
  const value = p.valueMm
  return { ...p, signer: config.signer, seller: config.seller, payer, signature: reply.signature, payloadHash,
    network: 'eip155:5042002', priceUsdc: amount.toString(), paymentReference, purchasedAt: Date.now(), valueMm: value }
}

/** One bounded paid attempt per mission. A failed or interrupted attempt requires
 * explicit operator retry because Gateway may have accepted payment before a
 * network failure, and automatic retries could charge twice. */
export async function purchaseSecondSource(m: MissionRecord): Promise<void> {
  if (m.secondSource || !m.chain || !m.spec.requireSecondSource) return
  const config = referenceConfig()
  if (!config) throw new Error('paid reference service is not configured; set FQ_REFERENCE_* variables')
  if (m.secondSourceAttemptAt) throw new Error('reference purchase already attempted; operator must review before retry')
  const buyer = privateKeyToAccount(config.key)
  if (buyer.address.toLowerCase() === m.chain.provider.toLowerCase()) throw new Error('reference buyer key is the primary provider')
  const client = new GatewayClient({ chain: 'arcTestnet', privateKey: config.key })
  client.onBeforePaymentCreation((ctx) => {
    const terms = ctx.selectedRequirements
    if (terms.network !== 'eip155:5042002' || terms.asset?.toLowerCase() !== '0x3600000000000000000000000000000000000000' || terms.payTo?.toLowerCase() !== config.seller.toLowerCase() || BigInt(terms.amount) !== REFERENCE_PRICE_USDC)
      return Promise.resolve({ abort: true as const, reason: 'Reference payment terms exceed the approved 0.001 USDC Arc Testnet offer' })
    return Promise.resolve()
  })
  const balances = await withTimeout(client.getBalances(), 15_000, 'Gateway balance check')
  if (balances.gateway.available < REFERENCE_PRICE_USDC) throw new Error('reference buyer Gateway balance is below 0.001 USDC')
  m.secondSourceAttemptAt = Date.now()
  missions.save()
  const url = `${config.url}/reference/${encodeURIComponent(m.chain.onchainId)}/${encodeURIComponent(m.spec.tile)}`
  const result = await withTimeout(client.pay<PaidReference>(url), 45_000, 'paid reference request')
  const reference = await validateReference(m, result.data, buyer.address, result.amount, result.transaction)
  m.secondSource = reference
  missions.save()
  audit(m, 'buyer', `Bought ${reference.provenance} reference reading from ${reference.sourceId} for 0.001 USDC via Gateway/x402`, 'info', { paymentReference: reference.paymentReference, payloadHash: reference.payloadHash })
}
