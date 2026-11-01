import { randomUUID } from 'node:crypto'
import { getAddress, isAddress, type Address } from 'viem'
import { account, config, hasRole } from './env'
import { errMsg, escrowRead, nowChainSec, readMission, registryRead, requireDeployment, send, waitForHash } from './chain'
import { HttpError } from './errors'
import { audit, missions, recoverInterruptedJobs, runJob } from './store'
import { ObservationRejected, recordTx, S } from './agents/common'
import { decide, fund, verifyQuote } from './agents/buyer'
import { acceptAssignment, profileByAddress, submitEvidence, withdrawCredits } from './agents/provider'
import { signAndSubmitVerdict } from './agents/verifier'
import { computeInvites } from './network'
import { feedbackEnabledFor, recordFeedback } from './feedback'
import { purchaseSecondSource, referenceConfig } from './second-source'
import { makeFixtureObservation, type FixtureVariant } from './fixture'
import { buildEvidence } from './evidence'
import { agentBudgetVaultAbi, missionEscrowAbi } from '../src/shared/abis'
import { hashCanonical } from '../src/shared/canonical'
import { parseUsdc } from '../src/onchain-money'
import type { MissionRecord, MissionSpec, SignedQuote, SignedReadingInput } from '../src/shared/types'
import { tileIdOf } from '../src/shared/typed'

export const TILE_RE = /^[A-F][1-4]$/
const MAX_BUDGET = parseUsdc('5')
const MARGIN_SEC = 2
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const UINT = /^\d{1,40}$/
const INT = /^-?\d{1,40}$/

export interface CreateReq {
  tile?: unknown
  scenario?: unknown
  budgetUsdc?: unknown
  deadlineMinutes?: unknown
  operator?: unknown
  autoFixture?: unknown
  requireSecondSource?: unknown
  challengeWindowSec?: unknown
  quoteWindowSec?: unknown
}

export { HttpError }

const isTerminal = (m: MissionRecord) =>
  m.stage === 'blocked' ||
  m.stage === 'failed' ||
  (['settled', 'expired'].includes(m.stage) &&
    m.jobs.reconcile?.status === 'done' &&
    (m.jobs.withdraw_provider?.status === 'done' || m.jobs.withdraw_provider?.status === 'failed' || !m.jobs.withdraw_provider) &&
    (m.jobs.withdraw_verifier?.status === 'done' || m.jobs.withdraw_verifier?.status === 'failed' || !m.jobs.withdraw_verifier) &&
    (!feedbackEnabledFor(m) || m.jobs.feedback?.status === 'done' || (m.jobs.feedback?.status === 'failed' && m.jobs.feedback.attempts >= 4)))

const str = (v: unknown, d: string): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : d)

export function createMission(req: CreateReq): MissionRecord {
  const tile = str(req.tile, '')
  if (!TILE_RE.test(tile)) throw new HttpError(400, 'tile must look like A1..F4')
  const scenario = (['accept', 'reject', 'dispute', 'custom'] as const).find((s) => s === req.scenario) ?? 'custom'
  let budget: bigint
  try {
    budget = parseUsdc(str(req.budgetUsdc, '1'))
  } catch {
    throw new HttpError(400, 'budgetUsdc must be a decimal USDC amount with at most 6 decimals')
  }
  if (budget <= config.verifierFeeUsdc || budget > MAX_BUDGET) throw new HttpError(400, 'budget must be above the verifier fee and at most 5 USDC (demo guard)')
  const minutes = Number(req.deadlineMinutes ?? 60)
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new HttpError(400, 'deadlineMinutes must be an integer from 5 to 240')
  const cw = Number(req.challengeWindowSec ?? 45)
  if (!Number.isInteger(cw) || cw < 0 || cw > 3600) throw new HttpError(400, 'challengeWindowSec must be 0..3600 in this app')
  const quoteWindowSec = scenario === 'custom' ? Number(req.quoteWindowSec ?? 90) : 0
  if (scenario === 'custom' && (!Number.isInteger(quoteWindowSec) || quoteWindowSec < 30 || quoteWindowSec > 600 || quoteWindowSec >= minutes * 60 - 60))
    throw new HttpError(400, 'quoteWindowSec must be 30..600 and leave at least 60 seconds before the mission deadline')
  let operator: Address
  if (req.operator === undefined || req.operator === '') {
    if (!hasRole('operator')) throw new HttpError(400, 'no demo operator configured; pass an operator address with an active vault policy')
    operator = account('operator').address
  } else if (typeof req.operator === 'string' && isAddress(req.operator)) operator = getAddress(req.operator)
  else throw new HttpError(400, 'operator must be an address')
  const busy = missions.all().find((x) => x.spec.tile === tile && !['settled', 'expired', 'blocked', 'failed'].includes(x.stage))
  if (busy) throw new HttpError(409, `tile ${tile} already has an active mission (${busy.id})`)

  const now = Math.floor(Date.now() / 1000)
  const spec: MissionSpec = {
    schema: 'fieldquest.mission/1',
    tile,
    region: 'A2A Marketplace data services',
    plotId: `A2A-SLOT-${tile}`,
    objective: `Deliver a signed water-level reading (mm) for data request ${tile} within ${minutes} minutes`,
    metric: 'water_level',
    unit: 'mm',
    plausibleMin: 0,
    plausibleMax: 2500,
    maxReadingAgeSec: 1800,
    deadlineUnix: now + minutes * 60,
    challengeWindowSec: cw,
    budgetUsdc: budget.toString(),
    requireSecondSource: req.requireSecondSource === true,
    evidenceRequirements: [
      'EIP-712 reading signed by a device key registered to the provider',
      'Observed after mission creation, no older than the max reading age',
      'Value inside plausibility bounds; second-source corroboration when required',
      'Single-use device nonce; raw payload hash matches the signed payloadHash',
    ],
  }
  const m: MissionRecord = {
    id: randomUUID().slice(0, 8),
    createdAt: Date.now(),
    operator,
    scenario,
    spec,
    specHash: hashCanonical(spec),
    ...(scenario === 'custom' ? { quoteDeadlineUnix: now + quoteWindowSec } : {}),
    stage: 'quoting',
    quotes: [],
    txs: [],
    audit: [],
    jobs: {},
    autoFixture: req.autoFixture === true,
  }
  missions.put(m)
  audit(m, 'operator', `A2A request ${tile} opened: budget ${str(req.budgetUsdc, '1')} USDC, deadline ${minutes} min, bid window ${quoteWindowSec}s. Spec hash ${m.specHash.slice(0, 12)}...`)
  return m
}

/** Accept a provider's independently signed quote while public bidding is open. */
export async function submitQuote(m: MissionRecord, body: unknown, signer: Address): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  if (m.stage !== 'quoting' || !m.quoteDeadlineUnix || now >= m.quoteDeadlineUnix) throw new HttpError(409, 'bidding is closed')
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const capability = input.evidenceCapability
  const caps = ['signed-device', 'signed-device+photo', 'field-operator']
  if (typeof input.provider !== 'string' || !isAddress(input.provider) || input.provider.toLowerCase() !== signer.toLowerCase()) throw new HttpError(403, 'quote provider must be the connected wallet')
  if (typeof input.providerName !== 'string' || input.providerName.trim().length < 2 || input.providerName.length > 48) throw new HttpError(400, 'providerName must be 2..48 characters')
  if (typeof input.priceUsdc !== 'string' || !UINT.test(input.priceUsdc) || BigInt(input.priceUsdc) <= 0n || BigInt(input.priceUsdc) + config.verifierFeeUsdc > BigInt(m.spec.budgetUsdc)) throw new HttpError(400, 'quote price exceeds the available provider budget')
  if (!Number.isInteger(input.etaSec) || Number(input.etaSec) < 60 || Number(input.etaSec) > m.spec.deadlineUnix - now) throw new HttpError(400, 'etaSec is outside the mission deadline')
  if (!Number.isInteger(input.validUntil) || Number(input.validUntil) <= m.quoteDeadlineUnix || Number(input.validUntil) > m.spec.deadlineUnix) throw new HttpError(400, 'quote validity must cover bidding and end by the mission deadline')
  if (!caps.includes(String(capability))) throw new HttpError(400, 'invalid evidence capability')
  if (typeof input.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new HttpError(400, 'invalid quote signature')
  if (typeof input.specHash !== 'string' || input.specHash.toLowerCase() !== m.specHash.toLowerCase() || typeof input.tileId !== 'string' || input.tileId.toLowerCase() !== tileIdOf(m.spec.tile).toLowerCase()) throw new HttpError(400, 'quote is for a different request')
  if (m.quotes.some((q) => q.provider.toLowerCase() === signer.toLowerCase())) throw new HttpError(409, 'this wallet already submitted a quote')
  const quote: SignedQuote = {
    quoteId: hashCanonical({ provider: signer, specHash: m.specHash, signature: input.signature }).slice(0, 18),
    provider: signer,
    providerName: input.providerName.trim(),
    priceUsdc: input.priceUsdc,
    etaSec: Number(input.etaSec),
    evidenceCapability: capability as SignedQuote['evidenceCapability'],
    validUntil: Number(input.validUntil),
    tileId: tileIdOf(m.spec.tile),
    specHash: m.specHash,
    signature: input.signature as `0x${string}`,
    simulated: false,
  }
  if (!(await verifyQuote(quote))) throw new HttpError(400, 'quote signature failed verification')
  // Signature recovery yields to other requests: repeat these checks before
  // mutating the shared mission so concurrent submissions cannot double-bid.
  if (m.stage !== 'quoting' || !m.quoteDeadlineUnix || Math.floor(Date.now() / 1000) >= m.quoteDeadlineUnix) throw new HttpError(409, 'bidding is closed')
  if (m.quotes.some((q) => q.provider.toLowerCase() === signer.toLowerCase())) throw new HttpError(409, 'this wallet already submitted a quote')
  m.quotes.push(quote)
  audit(m, 'provider', `${quote.providerName} submitted a verified public bid of ${quote.priceUsdc} USDC base units`, 'info', { quoteId: quote.quoteId })
}

const STAGE_BY_STATUS: Record<number, MissionRecord['stage']> = {
  [S.Funded]: 'funded',
  [S.Assigned]: 'awaiting_observation',
  [S.Submitted]: 'evidence_submitted',
  [S.Accepted]: 'challenge_window',
  [S.Rejected]: 'challenge_window',
  [S.Challenged]: 'challenged',
  [S.Expired]: 'expired',
  [S.Settled]: 'settled',
}

/** Advance one mission by at most one step per tick. Every step re-checks chain state first. */
export async function advance(m: MissionRecord) {
  if (isTerminal(m)) return
  if (!m.decision) {
    // Discovery runs once per custom request, before bidding closes. A failure never blocks the public auction.
    if (m.scenario === 'custom' && m.stage === 'quoting' && !m.invites) {
      const r = await runJob(m, 'invite', async () => computeInvites(m))
      if (r === 'failed' && (m.jobs.invite?.attempts ?? 0) >= 4) {
        m.invites = { at: Date.now(), entries: [], considered: 0, skipped: [], note: 'discovery unavailable; the public auction is unaffected' }
        missions.save()
      }
    }
    if (m.stage === 'quoting' && (!m.quoteDeadlineUnix || Math.floor(Date.now() / 1000) >= m.quoteDeadlineUnix)) await runJob(m, 'decide', async () => decide(m))
    return
  }
  if (!m.chain) {
    if (m.stage === 'blocked') return
    await runJob(m, 'fund', (job, setHash) => fund(m, setHash, job.txHash, job.attempts))
    return
  }
  const dep = requireDeployment()
  const id = BigInt(m.chain.onchainId)
  const on = await readMission(id)
  const now = await nowChainSec()
  const next = STAGE_BY_STATUS[on.status]
  if (next && next !== m.stage) {
    m.stage = next
    missions.save()
  }
  const call = (name: string, args: unknown[], role: 'providerA' | 'verifier' | 'arbiter' | 'operator' | 'buyer', label: string, agent: 'keeper' | 'arbiter') =>
    runJob(m, name, async (_job, setHash) => {
      const { hash, receipt } = await send(role, { address: dep.escrow, abi: missionEscrowAbi, functionName: name, args }, { onHash: setHash })
      recordTx(m, label, hash, role, receipt)
      audit(m, agent, `${label} confirmed onchain`, 'info', { txHash: hash })
    })
  // The keeper may be signed by any funded role: it only pays gas, anyone can call these functions.
  const keeperRole = 'verifier' as const

  switch (on.status) {
    case S.Funded:
      if (now > Number(on.deadline) + MARGIN_SEC) await call('expire', [id], keeperRole, 'keeper expires unaccepted mission and credits full refund', 'keeper')
      else if (profileByAddress(m.chain.provider)) await runJob(m, 'accept', (_j, setHash) => acceptAssignment(m, setHash))
      break
    case S.Assigned:
      if (now > Number(on.deadline) + MARGIN_SEC) {
        await call('expire', [id], keeperRole, 'keeper expires mission past deadline and credits full refund', 'keeper')
        break
      }
      if (!m.observation && m.autoFixture) {
        const prof = profileByAddress(m.chain.provider)
        if (prof) {
          const variant: FixtureVariant = m.scenario === 'reject' ? 'implausible' : m.scenario === 'dispute' ? 'ambiguous' : 'valid'
          m.observation = await makeFixtureObservation(m, variant, prof.sensor, m.chain.createdAtChain)
          audit(m, 'provider', `Provider agent ingested a SIMULATED fixture reading (variant: ${variant}) from its device adapter`, 'info')
        }
      }
      if (m.observation && profileByAddress(m.chain.provider)) {
        await runJob(m, 'submit', async (_j, setHash) => {
          try {
            await submitEvidence(m, setHash)
          } catch (e) {
            if (e instanceof ObservationRejected) {
              audit(m, 'provider', `Observation rejected before submission: ${e.message}`, 'error')
              m.observation = undefined
              return
            }
            throw e
          }
        })
        if (!m.observation) delete m.jobs.submit
        missions.save()
      }
      break
    case S.Submitted:
      if (now >= Number(on.submittedAt) + Number(await escrowRead<number>('VERIFIER_TIMEOUT')) + MARGIN_SEC && m.jobs.verdict?.status !== 'running') {
        await call('escalateStale', [id], keeperRole, 'keeper escalates stale mission (verifier gave no verdict)', 'keeper')
      } else {
        if (m.spec.requireSecondSource && !m.secondSource) {
          if (referenceConfig() && !m.secondSourceAttemptAt) await runJob(m, 'second_source', () => purchaseSecondSource(m))
          break // no reference means no affirmative verdict; preserve verifier timeout
        }
        await runJob(m, 'verdict', (_j, setHash) => signAndSubmitVerdict(m, setHash))
      }
      break
    case S.Accepted:
    case S.Rejected:
      if (now >= Number(on.challengeEndsAt) + MARGIN_SEC) await call('finalize', [id], keeperRole, 'keeper finalizes after challenge window and credits payouts', 'keeper')
      break
    case S.Challenged:
      if (now >= Number(on.challengedAt) + Number(await escrowRead<number>('ARBITER_TIMEOUT')) + MARGIN_SEC) {
        await call('resolveByTimeout', [id], keeperRole, 'keeper settles by arbiter timeout (signed verdict stands, or buyer refunded)', 'keeper')
      }
      break
    case S.Settled:
    case S.Expired: {
      if (m.chainOutcome !== on.outcome) {
        m.chainOutcome = on.outcome
        missions.save()
      }
      await runJob(m, 'reconcile', async (_j, setHash) => {
        const { hash, receipt } = await send('buyer', { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'reconcile', args: [dep.escrow, id] }, { onHash: setHash })
        recordTx(m, 'vault reconciles settlement and restores refund to operator budget', hash, 'buyer', receipt)
        audit(m, 'keeper', 'Vault reconciled: refund (if any) moved back into the operator available budget', 'info', { txHash: hash })
      })
      const prof = profileByAddress(m.chain.provider)
      if (on.outcome === 1 && prof) await runJob(m, 'withdraw_provider', (_j, setHash) => withdrawCredits(m, 'provider', prof.role, setHash))
      if (on.decision !== 0) await runJob(m, 'withdraw_verifier', (_j, setHash) => withdrawCredits(m, 'verifier', 'verifier', setHash))
      // Last, in its own job: a registry problem must never hold up reconcile, withdrawals or refunds.
      if (feedbackEnabledFor(m)) await runJob(m, 'feedback', async (j, setHash) => {
        await recordFeedback(m, setHash, j.txHash)
        if (m.feedback?.status === 'failed' || m.feedback?.status === 'partial') {
          // The receipt is final. A later attempt is safe: adapter flags prevent re-recording a successful role.
          j.txHash = undefined
          throw new Error(`ERC-8004 feedback ${m.feedback.status}; retrying only roles not recorded by the adapter`)
        }
      })
      break
    }
  }
}

export async function prepareExternalEvidence(m: MissionRecord, observation: SignedReadingInput): Promise<void> {
  if (!m.chain) throw new HttpError(409, 'mission is not funded onchain yet')
  const on = await readMission(BigInt(m.chain.onchainId))
  if (on.status !== S.Assigned) throw new HttpError(409, 'the external provider must accept the assignment onchain before preparing evidence')
  if (hashCanonical(observation.rawPayload).toLowerCase() !== observation.reading.payloadHash.toLowerCase()) throw new HttpError(400, 'raw payload hash does not match the signed reading')
  const reading = {
    missionId: BigInt(observation.reading.missionId), tileId: observation.reading.tileId,
    observedAt: BigInt(observation.reading.observedAt), value: BigInt(observation.reading.value),
    unit: observation.reading.unit, nonce: BigInt(observation.reading.nonce), payloadHash: observation.reading.payloadHash,
  }
  const dep = requireDeployment()
  try {
    await registryRead('previewReading', [dep.escrow, m.chain.provider,
      { missionId: BigInt(m.chain.onchainId), tileId: on.tileId, unit: on.unit, notBefore: on.createdAt, maxAge: on.maxReadingAge },
      reading, observation.signature])
  } catch (e) {
    throw new HttpError(400, `registry rejects this reading: ${errMsg(e)}`)
  }
  const { evidenceHash } = await buildEvidence(m, observation)
  m.evidenceHash = evidenceHash
  audit(m, 'provider', `External provider prepared content-addressed evidence ${evidenceHash.slice(0, 12)}...; wallet must commit it onchain`)
}

export async function submitObservation(m: MissionRecord, body: unknown, prepareExternal = prepareExternalEvidence): Promise<void> {
  if (!m.chain) throw new HttpError(409, 'mission is not funded onchain yet')
  if (m.observation && m.jobs.submit?.status === 'done') throw new HttpError(409, 'evidence already submitted onchain')
  const o = body as Partial<SignedReadingInput> | null
  const r = o?.reading
  if (!o || !r || typeof o.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) throw new HttpError(400, 'signature must be a 65-byte hex string')
  if (!UINT.test(String(r.missionId)) || !HEX32.test(String(r.tileId)) || !HEX32.test(String(r.unit)) || !HEX32.test(String(r.payloadHash)) || !UINT.test(String(r.nonce)) || !INT.test(String(r.value)) || !Number.isSafeInteger(r.observedAt))
    throw new HttpError(400, 'reading fields are malformed')
  if (r.missionId !== m.chain.onchainId) throw new HttpError(400, 'reading is for a different mission')
  if (!o.rawPayload || typeof o.rawPayload !== 'object' || JSON.stringify(o.rawPayload).length > 8000) throw new HttpError(400, 'rawPayload missing or too large')
  // 'simulated-fixture' stays labelled simulated in evidence and receipts; accepted only where the testnet fixture is enabled.
  const kind = o.kind === 'device-adapter' ? 'device-adapter' : o.kind === 'simulated-fixture' && config.fixtureEnabled ? 'simulated-fixture' : 'field-operator-upload'
  const observation: SignedReadingInput = {
    reading: { missionId: r.missionId, tileId: r.tileId, observedAt: r.observedAt, value: String(r.value), unit: r.unit, nonce: String(r.nonce), payloadHash: r.payloadHash },
    signature: o.signature,
    rawPayload: o.rawPayload,
    kind,
    deviceSerial: typeof o.deviceSerial === 'string' ? o.deviceSerial.slice(0, 64) : undefined,
    operatorNote: typeof o.operatorNote === 'string' ? o.operatorNote.slice(0, 280) : undefined,
    photoSha256: typeof o.photoSha256 === 'string' && HEX32.test(o.photoSha256) ? (o.photoSha256) : undefined,
  }
  if (!profileByAddress(m.chain.provider)) {
    await prepareExternal(m, observation)
  } else {
    audit(m, 'provider', `Signed observation received via ${kind}; managed provider agent will validate and submit its hash`)
  }
  m.observation = observation
  delete m.jobs.submit
  missions.save()
}

export async function fixtureObservation(m: MissionRecord, variant?: FixtureVariant) {
  if (!config.fixtureEnabled) throw new HttpError(403, 'simulated fixture is disabled in this environment')
  if (!m.chain) throw new HttpError(409, 'mission is not funded onchain yet')
  const prof = profileByAddress(m.chain.provider)
  if (!prof) throw new HttpError(409, 'provider is not managed by this server')
  const v: FixtureVariant = variant ?? (m.scenario === 'reject' ? 'implausible' : m.scenario === 'dispute' ? 'ambiguous' : 'valid')
  m.observation = await makeFixtureObservation(m, v, prof.sensor, m.chain.createdAtChain)
  delete m.jobs.submit
  audit(m, 'provider', `SIMULATED fixture reading (variant: ${v}) signed by testnet-only device key and queued`)
  missions.save()
}

export async function operatorChallenge(m: MissionRecord) {
  if (!m.chain) throw new HttpError(409, 'not funded')
  if (!hasRole('operator') || account('operator').address.toLowerCase() !== m.operator.toLowerCase())
    throw new HttpError(403, 'only the server-held demo operator can challenge from this API; other operators challenge from their own wallet via the vault')
  const dep = requireDeployment()
  try {
    const { hash, receipt } = await send('operator', { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'challengeMission', args: [dep.escrow, BigInt(m.chain.onchainId)] })
    recordTx(m, 'operator challenges accepted verdict', hash, 'operator', receipt)
    audit(m, 'operator', 'Operator challenged the verdict; mission is now with the human arbiter', 'warn', { txHash: hash })
  } catch (e) {
    throw new HttpError(409, errMsg(e))
  }
}

export async function arbiterResolve(m: MissionRecord, providerWins: boolean) {
  if (!m.chain) throw new HttpError(409, 'not funded')
  const dep = requireDeployment()
  try {
    const { hash, receipt } = await send('arbiter', { address: dep.escrow, abi: missionEscrowAbi, functionName: 'resolve', args: [BigInt(m.chain.onchainId), providerWins] })
    recordTx(m, `arbiter rules ${providerWins ? 'for provider' : 'for buyer'}`, hash, 'arbiter', receipt)
    audit(m, 'arbiter', `Human arbiter ruled ${providerWins ? 'for the provider' : 'for the buyer'} (server-held testnet arbiter key)`, 'info', { txHash: hash })
  } catch (e) {
    throw new HttpError(409, errMsg(e))
  }
}

let ticking = false
export function startLoop(intervalMs = 2500) {
  const n = recoverInterruptedJobs()
  if (n) console.log(`[pipeline] recovered ${n} interrupted job(s)`)
  // Re-attach to a tx hash a crashed process had already broadcast.
  void (async () => {
    for (const m of missions.all()) {
      for (const j of Object.values(m.jobs)) {
        if (j.status === 'pending' && j.txHash && j.key !== 'fund') {
          try {
            await waitForHash(j.txHash)
          } catch {
            /* the step re-checks chain state itself */
          }
        }
      }
    }
  })()
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      for (const m of missions.all().reverse()) {
        try {
          await advance(m)
        } catch (e) {
          audit(m, 'system', `pipeline error: ${errMsg(e)}`, 'error')
        }
      }
    } finally {
      ticking = false
    }
  }
  setInterval(() => void tick(), intervalMs)
}
