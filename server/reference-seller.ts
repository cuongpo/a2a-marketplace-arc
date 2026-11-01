import { readFileSync } from 'node:fs'
import express from 'express'
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server'
import { isAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hashCanonical } from '../src/shared/canonical'
import type { ReferencePayload } from './second-source'

/** Run separately from the buyer service with a separate key and feed owner.
 * The signed source value comes from a supplied file; there is no invented
 * measurement or fixture fallback. */
const rawKey = process.env.FQ_REFERENCE_SIGNER_KEY
const seller = process.env.FQ_REFERENCE_SELLER_ADDRESS
const feedFile = process.env.FQ_REFERENCE_FEED_FILE
if (process.env.FQ_NETWORK === 'mainnet') throw new Error('reference seller example runs on Arc Testnet only')
if (!rawKey || !/^0x[0-9a-fA-F]{64}$/.test(rawKey) || !seller || !isAddress(seller) || !feedFile)
  throw new Error('Reference seller needs FQ_REFERENCE_SIGNER_KEY, FQ_REFERENCE_SELLER_ADDRESS and FQ_REFERENCE_FEED_FILE')
const signer = privateKeyToAccount(rawKey as Hex)
if (signer.address.toLowerCase() !== seller.toLowerCase()) throw new Error('seller wallet must match the signing key')

type FeedItem = { valueMm: number; observedAt: number | 'now'; sourceId: string; provenance: ReferencePayload['provenance'] }
function feedFor(tile: string): FeedItem | null {
  const feed = JSON.parse(readFileSync(feedFile!, 'utf8')) as Record<string, FeedItem>
  const item = feed[tile]
  if (!item || !Number.isInteger(item.valueMm) || !(Number.isInteger(item.observedAt) || item.observedAt === 'now' && item.provenance === 'simulated-fixture') || !/^[\w .:-]{3,80}$/.test(item.sourceId) || !['field-operator-upload', 'device-adapter', 'simulated-fixture'].includes(item.provenance)) return null
  return item
}

const app = express()
const gateway = createGatewayMiddleware({ sellerAddress: seller, facilitatorUrl: 'https://gateway-api-testnet.circle.com', networks: ['eip155:5042002'], description: 'Mission-bound reference water-level reading' })
app.get('/health', (_req, res) => { res.json({ ok: true, chain: 'Arc Testnet', priceUsdc: '1000', signer: signer.address }) })
app.get('/reference/:missionId/:tile', (req, res, next) => {
  if (!/^\d{1,40}$/.test(req.params.missionId) || !/^[A-F][1-4]$/.test(req.params.tile) || !feedFor(req.params.tile)) { res.status(404).json({ error: 'reading unavailable' }); return }
  next()
}, gateway.require('$0.001'), async (req, res) => {
  const item = feedFor(req.params.tile)
  if (!item) { res.status(404).json({ error: 'reading unavailable' }); return }
  const payload: ReferencePayload = { schema: 'a2a.reference/1', missionId: req.params.missionId, tile: req.params.tile,
    ...item, observedAt: item.observedAt === 'now' ? Math.floor(Date.now() / 1000) : item.observedAt }
  const signature = await signer.signMessage({ message: { raw: hashCanonical(payload) } })
  const payment = (req as typeof req & { payment?: { payer?: string; amount?: string; network?: string; transaction?: string } }).payment
  if (!payment?.payer || payment.network !== 'eip155:5042002') { res.status(502).json({ error: 'verified Gateway payment metadata unavailable' }); return }
  res.json({ payload, signer: signer.address, seller, signature,
    paid: { payer: payment.payer, amount: payment.amount, network: payment.network, transaction: payment.transaction } })
})
const port = Number(process.env.FQ_REFERENCE_SELLER_PORT ?? 3002)
app.listen(port, '127.0.0.1', () => console.log(`[reference-seller] x402 on http://127.0.0.1:${port}; Arc Testnet; $0.001 per reading`))
