import type { Address } from 'viem'
import { account, hasRole, type Role } from '../env'
import {
  CHAIN_ID,
  errMsg,
  escrowRead,
  readMission,
  registryRead,
  requireDeployment,
  send,
  usdcBalance,
  waitForHash,
} from '../chain'
import { audit, nonceKey, nonces } from '../store'
import { buildEvidence } from '../evidence'
import { ObservationRejected, recordTx, S } from './common'
import { missionEscrowAbi } from '../../src/shared/abis'
import { quoteDomain, quoteTypes, tileIdOf } from '../../src/shared/typed'
import { hashCanonical } from '../../src/shared/canonical'
import type { MissionRecord, MissionSpec, SignedQuote } from '../../src/shared/types'

export interface ProviderProfile {
  role: 'providerA' | 'providerB'
  sensor: 'sensorA' | 'sensorB'
  name: string
  capability: SignedQuote['evidenceCapability']
  etaSec: number
}

export const PROVIDERS: ProviderProfile[] = [
  { role: 'providerA', sensor: 'sensorA', name: 'Delta Gauge Co-op', capability: 'signed-device', etaSec: 600 },
  { role: 'providerB', sensor: 'sensorB', name: 'Paddy Scout Network', capability: 'field-operator', etaSec: 1200 },
]

export function profileByAddress(addr: Address): ProviderProfile | undefined {
  return PROVIDERS.find((p) => hasRole(p.role) && account(p.role).address.toLowerCase() === addr.toLowerCase())
}

/** Scripted demo pricing per scenario (SIMULATED provider behaviour, labelled as such in the UI). */
function priceFor(p: ProviderProfile, scenario: MissionRecord['scenario']): bigint {
  const table: Record<MissionRecord['scenario'], [bigint, bigint]> = {
    accept: [400_000n, 550_000n],
    reject: [850_000n, 300_000n],
    dispute: [400_000n, 550_000n],
    custom: [450_000n, 350_000n],
  }
  return table[scenario][p.role === 'providerA' ? 0 : 1]
}

/** Each provider agent signs its own EIP-712 quote with its own wallet key. */
export async function quoteFor(
  p: ProviderProfile,
  spec: MissionSpec,
  specHash: `0x${string}`,
  scenario: MissionRecord['scenario'],
): Promise<SignedQuote> {
  const priceUsdc = priceFor(p, scenario)
  const validUntil = Math.floor(Date.now() / 1000) + 600
  const tileId = tileIdOf(spec.tile)
  const addr = account(p.role).address
  const signature = await account(p.role).signTypedData({
    domain: quoteDomain(CHAIN_ID),
    types: quoteTypes,
    primaryType: 'Quote',
    message: {
      provider: addr,
      specHash,
      tileId,
      priceUsdc,
      etaSec: BigInt(p.etaSec),
      validUntil: BigInt(validUntil),
      capability: p.capability,
    },
  })
  return {
    quoteId: hashCanonical({ addr, specHash, priceUsdc: String(priceUsdc), validUntil }).slice(0, 18),
    provider: addr,
    providerName: p.name,
    priceUsdc: String(priceUsdc),
    etaSec: p.etaSec,
    evidenceCapability: p.capability,
    validUntil,
    tileId,
    specHash,
    signature,
    simulated: true,
  }
}

export async function acceptAssignment(m: MissionRecord, setHash: (h: `0x${string}`) => void) {
  if (!m.chain) throw new Error('not funded')
  const dep = requireDeployment()
  const id = BigInt(m.chain.onchainId)
  const cur = await readMission(id)
  if (cur.status >= S.Assigned) return
  const role = profileByAddress(m.chain.provider)?.role
  if (!role) throw new Error('provider wallet is not managed by this server')
  const { hash, receipt } = await send(role, { address: dep.escrow, abi: missionEscrowAbi, functionName: 'acceptAssignment', args: [id] }, { onHash: setHash })
  recordTx(m, 'provider accepts assignment', hash, role, receipt)
  audit(m, 'provider', `${profileByAddress(m.chain.provider)?.name} accepted the assignment onchain`, 'info', { txHash: hash })
}

export async function submitEvidence(m: MissionRecord, setHash: (h: `0x${string}`) => void) {
  if (!m.chain || !m.observation) throw new Error('nothing to submit')
  const dep = requireDeployment()
  const id = BigInt(m.chain.onchainId)
  const cur = await readMission(id)
  if (cur.status >= S.Submitted) return
  const prof = profileByAddress(m.chain.provider)
  if (!prof) throw new Error('provider wallet is not managed by this server')
  const obs = m.observation
  const { bundle, evidenceHash, payloadHashOk } = await buildEvidence(m, obs)
  if (!payloadHashOk) throw new ObservationRejected('raw payload does not hash to the signed payloadHash')
  const reading = {
    missionId: BigInt(obs.reading.missionId),
    tileId: obs.reading.tileId,
    observedAt: BigInt(obs.reading.observedAt),
    value: BigInt(obs.reading.value),
    unit: obs.reading.unit,
    nonce: BigInt(obs.reading.nonce),
    payloadHash: obs.reading.payloadHash,
  }
  // Dry-run the registry check exactly as the escrow will run it, so a bad reading fails here with a reason.
  try {
    await registryRead('previewReading', [
      dep.escrow,
      m.chain.provider,
      { missionId: id, tileId: cur.tileId, unit: cur.unit, notBefore: cur.createdAt, maxAge: cur.maxReadingAge },
      reading,
      obs.signature,
    ])
  } catch (e) {
    throw new ObservationRejected(`registry would reject this reading: ${errMsg(e)}`)
  }
  m.evidenceHash = evidenceHash
  audit(m, 'provider', `Evidence bundle built and stored content-addressed (${evidenceHash.slice(0, 12)}...). Submitting hash onchain.`, 'info', {
    provenance: bundle.provenance.kind,
    simulated: bundle.provenance.simulated,
  })
  const { hash, receipt } = await send(
    prof.role,
    { address: dep.escrow, abi: missionEscrowAbi, functionName: 'submitEvidence', args: [id, evidenceHash, reading, obs.signature] },
    { onHash: setHash },
  )
  recordTx(m, 'provider submits evidence hash', hash, prof.role, receipt)
  nonces.set(nonceKey(bundle.signer, obs.reading.nonce), m.id)
  audit(m, 'provider', 'Evidence hash + reading commitment confirmed onchain', 'info', { txHash: hash })
}

/** Provider pulls its own credited USDC to its own wallet. Verifies the ERC-20 balance really moved. */
export async function withdrawCredits(
  m: MissionRecord,
  who: 'provider' | 'verifier',
  role: Role,
  setHash: (h: `0x${string}`) => void,
) {
  const dep = requireDeployment()
  const addr = account(role).address
  const credit = (await escrowRead<bigint>('credits', [addr]))
  if (credit === 0n) {
    audit(m, who, 'No credit to withdraw (already withdrawn or none owed)')
    return
  }
  const before = await usdcBalance(addr)
  const { hash, receipt } = await send(role, { address: dep.escrow, abi: missionEscrowAbi, functionName: 'withdraw', args: [addr] }, { onHash: setHash })
  const after = await usdcBalance(addr)
  recordTx(m, `${who} withdraws credited USDC`, hash, role, receipt)
  audit(m, who, `Withdrew ${credit.toString()} base units of USDC to own wallet; ERC-20 balance ${before} -> ${after}`, 'info', {
    txHash: hash,
    credit: credit.toString(),
  })
}

export { waitForHash }
