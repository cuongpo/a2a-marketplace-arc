import { recoverTypedDataAddress, type Address } from 'viem'
import { CHAIN_ID, requireDeployment } from './chain'
import { putEvidence, putPrivate } from './store'
import { hashCanonical } from '../src/shared/canonical'
import { readingTypes, registryDomain } from '../src/shared/typed'
import type { EvidenceBundle, MissionRecord, SignedReadingInput } from '../src/shared/types'

export function maskSerial(s?: string): string | undefined {
  if (!s) return undefined
  return s.length <= 4 ? '****' : s.slice(0, 2) + '*'.repeat(Math.max(2, s.length - 4)) + s.slice(-2)
}

export async function recoverReadingSigner(obs: SignedReadingInput): Promise<Address> {
  const dep = requireDeployment()
  return recoverTypedDataAddress({
    domain: registryDomain(CHAIN_ID, dep.registry),
    types: readingTypes,
    primaryType: 'Reading',
    message: {
      missionId: BigInt(obs.reading.missionId),
      tileId: obs.reading.tileId,
      observedAt: BigInt(obs.reading.observedAt),
      value: BigInt(obs.reading.value),
      unit: obs.reading.unit,
      nonce: BigInt(obs.reading.nonce),
      payloadHash: obs.reading.payloadHash,
    },
    signature: obs.signature,
  })
}

/**
 * Canonical evidence bundle. The PUBLIC bundle is hashed and committed onchain; the private body
 * (raw device payload, operator note, unmasked serial) is stored separately and committed by digest.
 */
export async function buildEvidence(m: MissionRecord, obs: SignedReadingInput) {
  if (!m.chain) throw new Error('mission not funded')
  const signer = await recoverReadingSigner(obs)
  const privateBody: Record<string, unknown> = {
    rawPayload: obs.rawPayload,
    deviceSerial: obs.deviceSerial ?? null,
    operatorNote: obs.operatorNote ?? null,
  }
  const privateDigest = putPrivate(privateBody)
  const simulated = obs.kind === 'simulated-fixture'
  const bundle: EvidenceBundle = {
    schema: 'fieldquest.evidence/1',
    missionRef: { chainId: m.chain.chainId, escrow: m.chain.escrow, missionId: m.chain.onchainId },
    tile: m.spec.tile,
    plotId: m.spec.plotId,
    provenance: {
      kind: obs.kind,
      simulated,
      label: simulated
        ? 'SIMULATED sensor fixture (testnet). Not a physical measurement.'
        : obs.kind === 'device-adapter'
          ? 'Reading from a device adapter. Signature proves key possession, not physical truth.'
          : 'Signed reading uploaded by a field operator. Signature proves key possession, not physical truth.',
      deviceSerialMasked: maskSerial(obs.deviceSerial),
    },
    reading: obs.reading,
    signature: obs.signature,
    signer,
    provider: m.chain.provider,
    ...(obs.photoSha256
      ? { photo: { sha256: obs.photoSha256, advisory: true as const, note: 'Advisory only: a photo hash is not proof of date or location.' } }
      : {}),
    privateDigest,
    // Deterministic on purpose: rebuilding the bundle after a restart yields the identical hash.
    createdAt: obs.reading.observedAt,
  }
  const evidenceHash = putEvidence(bundle)
  return { bundle, evidenceHash, privateDigest, payloadHashOk: hashCanonical(obs.rawPayload) === obs.reading.payloadHash }
}
