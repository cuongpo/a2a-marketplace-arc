import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { config } from './env'
import { canonicalize, hashCanonical } from '../src/shared/canonical'
import type { AgentRecord, AuditEntry, EvidenceBundle, JobRecord, MissionRecord } from '../src/shared/types'

/**
 * Persisted state. Atomic JSON writes (tmp + rename) so a crash never leaves a half-written file.
 * This is a CACHE of agent working state; money truth is always the chain. Evidence bundles are
 * content-addressed files whose name is their keccak256 hash.
 */

interface State {
  version: 2
  missions: Record<string, MissionRecord>
  /** signer:nonce -> local mission id. Verifier-side replay memory across missions. */
  seenNonces: Record<string, string>
  /** Open agent network directory, keyed by lowercase wallet. Public metadata only. */
  agents: Record<string, AgentRecord>
  /** Missions created before this time do not get automatic ERC-8004 feedback jobs (no surprise backfill of old missions). */
  feedbackFrom: number
}

const dir = config.dataDir
const statePath = join(dir, 'state.json')
const evidenceDir = join(dir, 'evidence')
const privateDir = join(dir, 'evidence-private')
for (const p of [dir, evidenceDir, privateDir]) if (!existsSync(p)) mkdirSync(p, { recursive: true })

let state: State = { version: 2, missions: {}, seenNonces: {}, agents: {}, feedbackFrom: Date.now() }
if (existsSync(statePath)) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<State> & { version?: number }
    // Safe migration: v1 files (no directory, no feedback epoch) are kept as a backup, then upgraded in place.
    if (parsed.version !== 2) copyFileSync(statePath, statePath + '.v1.bak')
    state = {
      version: 2,
      missions: parsed.missions ?? {},
      seenNonces: parsed.seenNonces ?? {},
      agents: parsed.agents ?? {},
      feedbackFrom: typeof parsed.feedbackFrom === 'number' ? parsed.feedbackFrom : Date.now(),
    }
    if (parsed.version !== 2) writeFileSync(statePath, JSON.stringify(state))
  } catch {
    // keep a copy of the unreadable file instead of silently discarding it
    renameSync(statePath, statePath + '.corrupt-' + Date.now())
  }
}

function save() {
  const tmp = statePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, statePath)
}

export const missions = {
  all: (): MissionRecord[] => Object.values(state.missions).sort((a, b) => b.createdAt - a.createdAt),
  get: (id: string): MissionRecord | undefined => state.missions[id],
  byOnchainId: (onchainId: string): MissionRecord | undefined =>
    Object.values(state.missions).find((m) => m.chain?.onchainId === onchainId),
  put: (m: MissionRecord) => {
    state.missions[m.id] = m
    save()
  },
  save,
}

export const agentDirectory = {
  all: (): AgentRecord[] => Object.values(state.agents).sort((a, b) => a.createdAt - b.createdAt),
  get: (wallet: string): AgentRecord | undefined => state.agents[wallet.toLowerCase()],
  byAgentId: (agentId: string): AgentRecord[] => Object.values(state.agents).filter((a) => a.agentId === agentId),
  put: (a: AgentRecord) => {
    state.agents[a.wallet.toLowerCase()] = a
    save()
  },
  save,
}
export const feedbackFrom = () => state.feedbackFrom

export function audit(
  m: MissionRecord,
  agent: AuditEntry['agent'],
  message: string,
  level: AuditEntry['level'] = 'info',
  data?: Record<string, unknown>,
) {
  m.audit.push({ at: Date.now(), agent, level, message, data })
  if (m.audit.length > 300) m.audit.splice(0, m.audit.length - 300)
  save()
}

export function recentFeed(limit = 80) {
  return Object.values(state.missions)
    .flatMap((m) => m.audit.map((a) => ({ ...a, missionId: m.id, tile: m.spec.tile })))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
}

export function nonceKey(signer: string, nonce: string) {
  return `${signer.toLowerCase()}:${nonce}`
}
export const nonces = {
  get: (k: string) => state.seenNonces[k],
  set: (k: string, missionId: string) => {
    state.seenNonces[k] = missionId
    save()
  },
}

// ---------- idempotent jobs ----------

const MAX_ATTEMPTS = 4
const BACKOFF_MS = 4_000

/**
 * Run `fn` at most once to completion per (mission, key). Safe across restarts: a finished job is
 * never re-run, a job that recorded a tx hash resumes by awaiting that hash instead of re-sending.
 * Callers must additionally re-check chain state inside `fn` (state-predicate idempotency).
 */
export async function runJob(
  m: MissionRecord,
  key: string,
  fn: (job: JobRecord, setHash: (h: Hex) => void) => Promise<void>,
): Promise<'done' | 'skipped' | 'failed'> {
  const job: JobRecord = m.jobs[key] ?? { key, status: 'pending', attempts: 0, updatedAt: 0 }
  m.jobs[key] = job
  if (job.status === 'done') return 'skipped'
  if (job.status === 'running') return 'skipped' // another tick is on it
  if (job.status === 'failed') {
    if (job.attempts >= MAX_ATTEMPTS) return 'skipped'
    if (Date.now() - job.updatedAt < BACKOFF_MS * job.attempts) return 'skipped'
  }
  job.status = 'running'
  job.attempts += 1
  job.updatedAt = Date.now()
  save()
  try {
    await fn(job, (h) => {
      job.txHash = h
      save()
    })
    job.status = 'done'
    job.lastError = undefined
    job.updatedAt = Date.now()
    save()
    return 'done'
  } catch (e) {
    job.status = 'failed'
    job.lastError = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)
    job.updatedAt = Date.now()
    save()
    audit(m, 'system', `job ${key} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${job.lastError}`, 'error')
    return 'failed'
  }
}

/** On boot, jobs left 'running' by a crashed process go back to pending (txHash, if any, is kept). */
export function recoverInterruptedJobs() {
  let n = 0
  for (const m of Object.values(state.missions)) {
    for (const j of Object.values(m.jobs)) {
      if (j.status === 'running') {
        j.status = 'pending'
        n++
      }
    }
  }
  if (n) save()
  return n
}

// ---------- content-addressed evidence ----------

export function putEvidence(bundle: EvidenceBundle): Hex {
  const h = hashCanonical(bundle)
  writeFileSync(join(evidenceDir, `${h}.json`), canonicalize(bundle))
  return h
}
export function getEvidence(hash: string): EvidenceBundle | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  const p = join(evidenceDir, `${hash.toLowerCase()}.json`)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as EvidenceBundle) : null
}
/** Private body (raw device payload, operator note): NOT served publicly. Committed by digest in the bundle. */
export function putPrivate(body: Record<string, unknown>): Hex {
  const h = hashCanonical(body)
  writeFileSync(join(privateDir, `${h}.json`), canonicalize(body))
  return h
}
export function getPrivate(digest: string): Record<string, unknown> | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) return null
  const p = join(privateDir, `${digest.toLowerCase()}.json`)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : null
}

export function reliabilityOf(provider: string): { ok: number; total: number; score: number } {
  let ok = 0
  let total = 0
  for (const m of Object.values(state.missions)) {
    if (m.chain?.provider.toLowerCase() !== provider.toLowerCase()) continue
    if (m.stage === 'settled' || m.stage === 'expired') {
      total++
      if (m.chainOutcome === 1 || (m.chainOutcome === undefined && m.verdict?.decision === 'accept' && m.stage === 'settled')) ok++
    }
  }
  // Laplace-smoothed success rate: unknown providers start at 0.5, not at 1.0.
  return { ok, total, score: (ok + 1) / (total + 2) }
}
