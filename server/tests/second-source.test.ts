import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { hashCanonical } from '../../src/shared/canonical'
import type { MissionRecord } from '../../src/shared/types'
import { REFERENCE_PRICE_USDC, validateReference, type ReferencePayload } from '../second-source'

const seller = privateKeyToAccount(`0x${'1'.repeat(64)}`)
const buyer = privateKeyToAccount(`0x${'2'.repeat(64)}`)
const provider = privateKeyToAccount(`0x${'3'.repeat(64)}`)
const saved = Object.fromEntries(['FQ_REFERENCE_SERVICE_URL', 'FQ_REFERENCE_BUYER_KEY', 'FQ_REFERENCE_SIGNER_ADDRESS', 'FQ_REFERENCE_SELLER_ADDRESS'].map((key) => [key, process.env[key]]))
beforeAll(() => {
  process.env.FQ_REFERENCE_SERVICE_URL = 'http://127.0.0.1:3002'
  process.env.FQ_REFERENCE_BUYER_KEY = `0x${'2'.repeat(64)}`
  process.env.FQ_REFERENCE_SIGNER_ADDRESS = seller.address
  process.env.FQ_REFERENCE_SELLER_ADDRESS = seller.address
})
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })

const now = Math.floor(Date.now() / 1000)
const mission = {
  chain: { onchainId: '42', createdAtChain: now - 100, provider: provider.address },
  spec: { tile: 'B2', requireSecondSource: true },
} as MissionRecord
const payload: ReferencePayload = { schema: 'a2a.reference/1', missionId: '42', tile: 'B2', valueMm: 420, observedAt: now - 5, sourceId: 'Independent gauge', provenance: 'field-operator-upload' }
async function reply(p: ReferencePayload = payload) {
  return { payload: p, signature: await seller.signMessage({ message: { raw: hashCanonical(p) } }), signer: seller.address, seller: seller.address,
    paid: { payer: buyer.address, network: 'eip155:5042002', amount: '1000' } }
}

describe('paid reference validation', () => {
  test('accepts the signed, mission-bound response at the exact x402 price', async () => {
    const record = await validateReference(mission, await reply(), buyer.address, REFERENCE_PRICE_USDC, 'gateway-payment-42')
    expect(record.valueMm).toBe(420)
    expect(record.payloadHash).toBe(hashCanonical(payload))
    expect(record.priceUsdc).toBe('1000')
  })
  test('rejects a changed reading after signing', async () => {
    const tampered = await reply()
    tampered.payload = { ...tampered.payload, valueMm: 999 }
    await expect(validateReference(mission, tampered, buyer.address, REFERENCE_PRICE_USDC, 'pay')).rejects.toThrow('signature')
  })
  test('rejects a different mission and an unexpected charge', async () => {
    await expect(validateReference(mission, await reply({ ...payload, missionId: '43' }), buyer.address, REFERENCE_PRICE_USDC, 'pay')).rejects.toThrow('mission')
    await expect(validateReference(mission, await reply(), buyer.address, 2000n, 'pay')).rejects.toThrow('amount')
  })
  test('rejects the winning provider as its own reference source', async () => {
    const self = { ...mission, chain: { ...mission.chain!, provider: seller.address } } as MissionRecord
    await expect(validateReference(self, await reply(), buyer.address, REFERENCE_PRICE_USDC, 'pay')).rejects.toThrow('primary provider')
  })
})
