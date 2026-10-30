import { randomUUID } from 'node:crypto'
import { getAddress, isAddress, type Address } from 'viem'
import { account, config, hasRole } from './env'
import { errMsg, escrowRead, nowChainSec, readMission, requireDeployment, send, waitForHash } from './chain'
import { audit, missions, recoverInterruptedJobs, runJob } from './store'
import { ObservationRejected, recordTx, S } from './agents/common'
import { decide, fund } from './agents/buyer'
import { acceptAssignment, profileByAddress, submitEvidence, withdrawCredits } from './agents/provider'
import { signAndSubmitVerdict } from './agents/verifier'
import { makeFixtureObservation, type FixtureVariant } from './fixture'
import { agentBudgetVaultAbi, missionEscrowAbi } from '../src/shared/abis'
import { hashCanonical } from '../src/shared/canonical'
import { parseUsdc } from '../src/onchain-money'
import type { MissionRecord, MissionSpec, SignedReadingInput } from '../src/shared/types'

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
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const isTerminal = (m: MissionRecord) =>
  m.stage === 'blocked' ||
  m.stage === 'failed' ||
  (['settled', 'expired'].includes(m.stage) &&
    m.jobs.reconcile?.status === 'done' &&
    (m.jobs.withdraw_provider?.status === 'done' || m.jobs.withdraw_provider?.status === 'failed' || !m.jobs.withdraw_provider) &&
    (m.jobs.withdraw_verifier?.status === 'done' || m.jobs.withdraw_verifier?.status === 'failed' || !m.jobs.withdraw_verifier))

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
    region: 'Mekong Delta rice terraces (fictional demo plots)',
    plotId: `MKD-FIC-${tile}`,
    objective: `Obtain a signed water-level reading (mm) for rice-field tile ${tile} within ${minutes} minutes`,
    metric: 'water_level',
    unit: 'mm',
    plausibleMin: 0,
    plausibleMax: 2500,
    maxReadingAgeSec: 1800,
    deadlineUnix: now + minutes * 60,
    challengeWindowSec: cw,
    budgetUsdc: budget.toString(),
    requireSecondSource: req.requireSecondSource !== false,
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
    stage: 'quoting',
    quotes: [],
    txs: [],
    audit: [],
    jobs: {},
    autoFixture: req.autoFixture === true,
  }
  missions.put(m)
  audit(m, 'operator', `Mission created for tile ${tile}: budget ${str(req.budgetUsdc, '1')} USDC, deadline ${minutes} min, scenario ${scenario}. Spec hash ${m.specHash.slice(0, 12)}...`)
  return m
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
    if (m.stage === 'quoting') await runJob(m, 'decide', async () => decide(m))
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
      else await runJob(m, 'accept', (_j, setHash) => acceptAssignment(m, setHash))
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
      if (m.observation) {
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
      } else await runJob(m, 'verdict', (_j, setHash) => signAndSubmitVerdict(m, setHash))
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
      await runJob(m, 'reconcile', async (_j, setHash) => {
        const { hash, receipt } = await send('buyer', { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'reconcile', args: [dep.escrow, id] }, { onHash: setHash })
        recordTx(m, 'vault reconciles settlement and restores refund to operator budget', hash, 'buyer', receipt)
        audit(m, 'keeper', 'Vault reconciled: refund (if any) moved back into the operator available budget', 'info', { txHash: hash })
      })
      const prof = profileByAddress(m.chain.provider)
      if (on.outcome === 1 && prof) await runJob(m, 'withdraw_provider', (_j, setHash) => withdrawCredits(m, 'provider', prof.role, setHash))
      if (on.decision !== 0) await runJob(m, 'withdraw_verifier', (_j, setHash) => withdrawCredits(m, 'verifier', 'verifier', setHash))
      break
    }
  }
}

export function submitObservation(m: MissionRecord, body: unknown): void {
  if (!m.chain) throw new HttpError(409, 'mission is not funded onchain yet')
  if (m.observation && m.jobs.submit?.status === 'done') throw new HttpError(409, 'evidence already submitted onchain')
  const o = body as Partial<SignedReadingInput> | null
  const r = o?.reading
  if (!o || !r || typeof o.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) throw new HttpError(400, 'signature must be a 65-byte hex string')
  if (!UINT.test(String(r.missionId)) || !HEX32.test(String(r.tileId)) || !HEX32.test(String(r.unit)) || !HEX32.test(String(r.payloadHash)) || !UINT.test(String(r.nonce)) || !INT.test(String(r.value)) || !Number.isSafeInteger(r.observedAt))
    throw new HttpError(400, 'reading fields are malformed')
  if (r.missionId !== m.chain.onchainId) throw new HttpError(400, 'reading is for a different mission')
  if (!o.rawPayload || typeof o.rawPayload !== 'object' || JSON.stringify(o.rawPayload).length > 8000) throw new HttpError(400, 'rawPayload missing or too large')
  const kind = o.kind === 'device-adapter' ? 'device-adapter' : 'field-operator-upload'
  m.observation = {
    reading: { missionId: r.missionId, tileId: r.tileId, observedAt: r.observedAt, value: String(r.value), unit: r.unit, nonce: String(r.nonce), payloadHash: r.payloadHash },
    signature: o.signature,
    rawPayload: o.rawPayload,
    kind,
    deviceSerial: typeof o.deviceSerial === 'string' ? o.deviceSerial.slice(0, 64) : undefined,
    operatorNote: typeof o.operatorNote === 'string' ? o.operatorNote.slice(0, 280) : undefined,
    photoSha256: typeof o.photoSha256 === 'string' && HEX32.test(o.photoSha256) ? (o.photoSha256) : undefined,
  }
  delete m.jobs.submit
  audit(m, 'provider', `Signed observation received via ${kind}; provider agent will validate and submit its hash`)
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
