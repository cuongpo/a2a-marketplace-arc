import { account, config } from './env'
import { CHAIN_ID, requireDeployment } from './chain'
import { hashCanonical } from '../src/shared/canonical'
import { registryDomain, readingTypes, tileIdOf, unitIdOf } from '../src/shared/typed'
import type { MissionRecord, SignedReadingInput } from '../src/shared/types'
import { keccak256, toBytes } from 'viem'

/**
 * SIMULATED sensor fixture. It signs a reading with a testnet-only device key so the full
 * onchain signature path can be exercised. It is NOT a physical measurement and every artifact
 * it produces is labelled as simulated. Disabled when FQ_NETWORK=mainnet or FQ_ENABLE_FIXTURE=0.
 */
export type FixtureVariant = 'valid' | 'implausible' | 'ambiguous'

export const FIXTURE_LABEL = 'SIMULATED sensor fixture (testnet only). Not a physical measurement.'

/** Simulated independent reference gauge for second-source corroboration (also a fixture). */
export function referenceGaugeMm(tile: string): number {
  const h = Number(BigInt(keccak256(toBytes('ref:' + tile))) % 120n)
  return 380 + h
}

export function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(12))
  return BigInt('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')).toString()
}

export async function makeFixtureObservation(
  m: MissionRecord,
  variant: FixtureVariant,
  sensor: 'sensorA' | 'sensorB',
  missionCreatedAtChain: number,
): Promise<SignedReadingInput> {
  if (!config.fixtureEnabled) throw new Error('Simulated fixture is disabled in this environment')
  if (!m.chain) throw new Error('Mission is not funded onchain yet')
  const dep = requireDeployment()
  const ref = referenceGaugeMm(m.spec.tile)
  const jitter = Number(BigInt(keccak256(toBytes(m.id))) % 25n) - 12
  const value = variant === 'valid' ? ref + jitter : variant === 'implausible' ? 9650 : ref + 310
  // never earlier than the mission's creation block time, never in the future
  const observedAt = Math.max(missionCreatedAtChain + 1, Math.floor(Date.now() / 1000) - 3)
  const rawPayload: Record<string, unknown> = {
    device: sensor === 'sensorA' ? 'FQ-SIM-GAUGE-A' : 'FQ-SIM-GAUGE-B',
    fixture: true,
    label: FIXTURE_LABEL,
    variant,
    value_mm: value,
    sampledAt: observedAt,
  }
  const reading = {
    missionId: m.chain.onchainId,
    tileId: tileIdOf(m.spec.tile),
    observedAt,
    value: String(value),
    unit: unitIdOf(m.spec.unit),
    nonce: randomNonce(),
    payloadHash: hashCanonical(rawPayload),
  }
  const signature = await account(sensor).signTypedData({
    domain: registryDomain(CHAIN_ID, dep.registry),
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
  return {
    reading,
    signature,
    rawPayload,
    kind: 'simulated-fixture',
    deviceSerial: String(rawPayload.device),
    operatorNote: FIXTURE_LABEL,
  }
}
