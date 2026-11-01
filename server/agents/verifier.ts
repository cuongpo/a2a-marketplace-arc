import { recoverMessageAddress, recoverTypedDataAddress } from 'viem'
import { account } from '../env'
import { CHAIN_ID, errMsg, readMission, registryRead, requireDeployment, send } from '../chain'
import { audit, getEvidence, getPrivate, nonceKey, nonces } from '../store'
import { randomNonce } from '../fixture'
import { REFERENCE_PRICE_USDC } from '../second-source'
import { recordTx, S } from './common'
import { missionEscrowAbi } from '../../src/shared/abis'
import { hashCanonical } from '../../src/shared/canonical'
import { DECISION, escrowDomain, readingTypes, registryDomain, verdictTypes } from '../../src/shared/typed'
import type { MissionRecord, VerdictRecord } from '../../src/shared/types'

export const SECOND_SOURCE_TOLERANCE_MM = 80

type Check = VerdictRecord['reasons'][number]

/**
 * Deterministic verification. No LLM is involved or required. Hard failures reject; a disagreement
 * with an independent second source is AMBIGUOUS, which escalates to human review rather than
 * claiming a definitive physical-world truth.
 */
export async function verify(m: MissionRecord): Promise<{ decision: VerdictRecord['decision']; reasons: Check[] }> {
  if (!m.chain) throw new Error('not funded')
  const dep = requireDeployment()
  const id = BigInt(m.chain.onchainId)
  const on = await readMission(id)
  const reasons: Check[] = []
  const add = (code: string, ok: boolean, detail: string) => reasons.push({ code, ok, detail })

  const bundle = getEvidence(on.evidenceHash)
  if (!bundle) {
    add('bundle_available', false, 'evidence bundle for the onchain hash is not in the content-addressed store')
    return { decision: 'reject', reasons }
  }
  add('bundle_hash', hashCanonical(bundle) === on.evidenceHash, 'keccak256(canonical bundle) equals the onchain evidenceHash')
  add('schema', bundle.schema === 'fieldquest.evidence/1' && /^\d+$/.test(bundle.reading.nonce) && /^-?\d+$/.test(bundle.reading.value), 'bundle schema and numeric fields')
  add(
    'mission_match',
    bundle.missionRef.missionId === m.chain.onchainId &&
      bundle.reading.missionId === m.chain.onchainId &&
      bundle.missionRef.escrow.toLowerCase() === dep.escrow.toLowerCase() &&
      bundle.missionRef.chainId === CHAIN_ID,
    'bundle and reading are bound to this mission, escrow and chain',
  )
  add('tile_match', bundle.reading.tileId.toLowerCase() === on.tileId.toLowerCase() && bundle.tile === m.spec.tile, `reading is for tile ${m.spec.tile}`)
  add('unit_match', bundle.reading.unit.toLowerCase() === on.unit.toLowerCase(), `unit is ${m.spec.unit}`)

  const message = {
    missionId: BigInt(bundle.reading.missionId),
    tileId: bundle.reading.tileId,
    observedAt: BigInt(bundle.reading.observedAt),
    value: BigInt(bundle.reading.value),
    unit: bundle.reading.unit,
    nonce: BigInt(bundle.reading.nonce),
    payloadHash: bundle.reading.payloadHash,
  }
  try {
    const signer = await recoverTypedDataAddress({
      domain: registryDomain(CHAIN_ID, dep.registry),
      types: readingTypes,
      primaryType: 'Reading',
      message,
      signature: bundle.signature,
    })
    const info = await registryRead<readonly [string, boolean, string]>('signerInfo', [signer])
    const ok = signer.toLowerCase() === bundle.signer.toLowerCase() && info[1] && info[0].toLowerCase() === on.provider.toLowerCase()
    add('sensor_signature', ok, ok ? `signed by device key ${signer.slice(0, 10)}... bound to the provider in the registry` : 'signature does not match an active registry binding for this provider')
  } catch (e) {
    add('sensor_signature', false, `signature recovery failed: ${errMsg(e)}`)
  }

  try {
    const digest = await registryRead<string>('hashReading', [message])
    add('reading_commitment', digest.toLowerCase() === on.readingCommitment.toLowerCase(), 'EIP-712 digest of the reading equals the onchain readingCommitment')
  } catch (e) {
    add('reading_commitment', false, errMsg(e))
  }

  const consumed = await registryRead<boolean>('nonceUsed', [dep.escrow, bundle.signer, BigInt(bundle.reading.nonce)])
  const prior = nonces.get(nonceKey(bundle.signer, bundle.reading.nonce))
  add(
    'nonce_unique',
    consumed && (!prior || prior === m.id),
    prior && prior !== m.id ? `nonce already used on mission ${prior}` : 'nonce consumed once onchain; not seen on any other mission',
  )

  const priv = getPrivate(bundle.privateDigest)
  if (priv) {
    add('private_digest', hashCanonical(priv) === bundle.privateDigest, 'private body matches its committed digest')
    add('payload_hash', hashCanonical(priv.rawPayload) === bundle.reading.payloadHash, 'raw device payload hashes to the signed payloadHash')
  } else {
    add('private_digest', false, 'private body unavailable to the verifier')
  }

  const observedAt = Number(bundle.reading.observedAt)
  const submittedAt = Number(on.submittedAt)
  add(
    'freshness',
    observedAt >= Number(on.createdAt) && submittedAt - observedAt <= on.maxReadingAge && observedAt <= submittedAt + 60,
    `observed ${submittedAt - observedAt}s before submission; mission allows ${on.maxReadingAge}s and requires a reading after creation`,
  )
  const value = Number(bundle.reading.value)
  add('plausibility', value >= m.spec.plausibleMin && value <= m.spec.plausibleMax, `value ${value} ${m.spec.unit} vs plausible range [${m.spec.plausibleMin}, ${m.spec.plausibleMax}]`)
  add(
    'provenance',
    true,
    bundle.provenance.simulated
      ? 'Provenance: SIMULATED fixture. Accepting it only exercises the protocol; it proves nothing about the physical world.'
      : `Provenance: ${bundle.provenance.kind}. A valid signature proves key possession, not physical truth.`,
  )

  if (reasons.some((r) => !r.ok)) return { decision: 'reject', reasons }

  if (m.spec.requireSecondSource) {
    const ref = m.secondSource
    if (!ref) {
      add('second_source', false, 'No paid, signed second-source reading is available; independent corroboration is pending')
      return { decision: 'escalate', reasons }
    }
    const payload = { schema: ref.schema, missionId: ref.missionId, tile: ref.tile, valueMm: ref.valueMm, observedAt: ref.observedAt, sourceId: ref.sourceId, provenance: ref.provenance }
    const hash = hashCanonical(payload)
    let signatureValid = false
    try {
      const recovered = await recoverMessageAddress({ message: { raw: hash }, signature: ref.signature })
      signatureValid = recovered.toLowerCase() === ref.signer.toLowerCase()
    } catch { /* invalid signature */ }
    const independent = ref.signer.toLowerCase() !== on.provider.toLowerCase() && ref.seller.toLowerCase() !== on.provider.toLowerCase()
    const bound = ref.missionId === m.chain.onchainId && ref.tile === m.spec.tile && ref.observedAt >= Number(on.createdAt) && ref.observedAt <= Math.floor(ref.purchasedAt / 1000) + 30
    const payment = ref.priceUsdc === REFERENCE_PRICE_USDC.toString() && ref.network === 'eip155:5042002' && !!ref.paymentReference
    add('second_source_signature', signatureValid && ref.payloadHash.toLowerCase() === hash.toLowerCase() && independent && bound,
      `reference signed by ${ref.signer}; source ${ref.sourceId}; distinct from primary provider; bound to mission`)
    add('second_source_payment', payment, `Gateway/x402 authorization for ${ref.priceUsdc} atomic USDC; reference ${ref.paymentReference}`)
    if (!signatureValid || !independent || !bound || !payment) return { decision: 'reject', reasons }
    const diff = Math.abs(ref.valueMm - value)
    const ok = diff <= SECOND_SOURCE_TOLERANCE_MM
    add('second_source', ok, `${ref.sourceId} (${ref.provenance}) reads ${ref.valueMm} ${m.spec.unit}; difference ${diff}, tolerance ${SECOND_SOURCE_TOLERANCE_MM}. Signed testimony does not establish physical truth.`)
    if (!ok) return { decision: 'escalate', reasons }
  }
  return { decision: 'accept', reasons }
}

export async function signAndSubmitVerdict(m: MissionRecord, setHash: (h: `0x${string}`) => void) {
  if (!m.chain) throw new Error('not funded')
  const dep = requireDeployment()
  const id = BigInt(m.chain.onchainId)
  const cur = await readMission(id)
  if (cur.status !== S.Submitted) return
  const base = m.verdict ? { decision: m.verdict.decision, reasons: m.verdict.reasons } : await verify(m)
  const { decision, reasons } = base
  const failed = reasons.filter((r) => !r.ok)
  const reasonHash = m.verdict?.reasonHash ?? hashCanonical({ decision, reasons })
  const nonce = m.verdict?.nonce ?? randomNonce()
  const expiry = m.verdict?.expiry ?? Math.floor(Date.now() / 1000) + 1800
  const message = {
    missionId: id,
    evidenceHash: cur.evidenceHash,
    decision: DECISION[decision],
    reasonHash,
    expiry: BigInt(expiry),
    nonce: BigInt(nonce),
  }
  const signature =
    m.verdict?.signature ??
    (await account('verifier').signTypedData({
      domain: escrowDomain(CHAIN_ID, dep.escrow),
      types: verdictTypes,
      primaryType: 'Verdict',
      message,
    }))
  m.verdict = { decision, reasons, reasonHash, nonce, expiry, signature, verifier: account('verifier').address }
  audit(
    m,
    'verifier',
    decision === 'accept'
      ? 'Verdict: ACCEPT. All deterministic checks passed.'
      : decision === 'reject'
        ? `Verdict: REJECT. Failed checks: ${failed.map((f) => f.code).join(', ')}`
        : `Verdict: ESCALATE to human dispute review (evidence is ambiguous): ${failed.map((f) => f.detail).join('; ') || 'second source disagrees'}`,
    decision === 'reject' ? 'warn' : 'info',
    { reasons },
  )
  const { hash, receipt } = await send('verifier', { address: dep.escrow, abi: missionEscrowAbi, functionName: 'submitVerdict', args: [message, signature] }, { onHash: setHash })
  recordTx(m, `verifier submits signed ${decision} verdict`, hash, 'verifier', receipt)
  audit(m, 'verifier', `Signed EIP-712 verdict confirmed onchain (${decision})`, 'info', { txHash: hash })
}
