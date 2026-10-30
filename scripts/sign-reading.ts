// Offline signer for a REAL device key or field-operator workflow (no server access to the key).
// Produces the JSON accepted by POST /api/missions/:id/observation (or the UI paste box).
//
//   DEVICE_KEY=0x... bun run scripts/sign-reading.ts --onchain-id 7 --tile B2 --value 412 \
//        --serial GAUGE-0042 --payload '{"raw":"412mm","probe":"ultrasonic"}' [--kind device-adapter|field-operator-upload]
//
// The device key must first be registered to the provider (registry.registerSigner). A valid signature
// proves the key holder signed this reading; it does not prove the water level is true.
import { privateKeyToAccount } from 'viem/accounts'
import { CHAIN_ID, requireDeployment } from '../server/chain'
import { hashCanonical } from '../src/shared/canonical'
import { readingTypes, registryDomain, tileIdOf, unitIdOf } from '../src/shared/typed'
import type { SignedReadingInput } from '../src/shared/types'
import type { Hex } from 'viem'

export async function signReading(opts: {
  key: Hex
  onchainId: string
  tile: string
  valueMm: number
  rawPayload: Record<string, unknown>
  serial?: string
  kind?: 'device-adapter' | 'field-operator-upload'
  observedAt?: number
}): Promise<SignedReadingInput> {
  const acct = privateKeyToAccount(opts.key)
  const reading = {
    missionId: opts.onchainId,
    tileId: tileIdOf(opts.tile),
    observedAt: opts.observedAt ?? Math.floor(Date.now() / 1000),
    value: String(Math.round(opts.valueMm)),
    unit: unitIdOf('mm'),
    nonce: BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')).toString(),
    payloadHash: hashCanonical(opts.rawPayload),
  }
  const signature = await acct.signTypedData({
    domain: registryDomain(CHAIN_ID, requireDeployment().registry),
    types: readingTypes,
    primaryType: 'Reading',
    message: {
      missionId: BigInt(reading.missionId),
      tileId: reading.tileId,
      observedAt: BigInt(reading.observedAt),
      value: BigInt(reading.value),
      unit: reading.unit,
      nonce: BigInt(reading.nonce),
      payloadHash: reading.payloadHash,
    },
  })
  return { reading, signature, rawPayload: opts.rawPayload, kind: opts.kind ?? 'field-operator-upload', deviceSerial: opts.serial }
}

if (import.meta.main) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const key = process.env.DEVICE_KEY as Hex | undefined
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set DEVICE_KEY to the registered device private key (never commit it).')
  const onchainId = arg('onchain-id')
  const tile = arg('tile')
  const value = Number(arg('value'))
  if (!onchainId || !tile || !Number.isFinite(value)) throw new Error('Required: --onchain-id --tile --value')
  const out = await signReading({
    key,
    onchainId,
    tile,
    valueMm: value,
    rawPayload: JSON.parse(arg('payload') ?? '{}') as Record<string, unknown>,
    serial: arg('serial'),
    kind: arg('kind') === 'device-adapter' ? 'device-adapter' : 'field-operator-upload',
  })
  console.log(JSON.stringify(out, null, 2))
}
