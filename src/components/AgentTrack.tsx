import { motion, useReducedMotion } from 'framer-motion'
import { Check, Coins, Gavel, Radar, ScanSearch, X, type LucideIcon } from 'lucide-react'
import type { PMission } from '@/lib/api'

const ZERO = '0x' + '0'.repeat(64)
const AFTER = (st: string | undefined, list: string[]) => !!st && list.includes(st)

/** Which step is current, derived ONLY from persisted stage + confirmed onchain status. */
export function stepOf(m: PMission): { note: string; terminal: boolean; bad: boolean } {
  const st = m.onchain?.status
  if (m.stage === 'blocked' || m.stage === 'failed') return { note: m.stageNote ?? m.stage, terminal: true, bad: true }
  if (!m.decision) return { note: 'Buyer agent collecting signed quotes', terminal: false, bad: false }
  if (!m.chain) return { note: 'Buyer agent funding from the vault within policy', terminal: false, bad: false }
  switch (st) {
    case 'Funded':
      return { note: 'Waiting for the provider to accept the assignment', terminal: false, bad: false }
    case 'Assigned':
      return { note: m.observation ? 'Provider validating and submitting evidence' : 'Waiting for a signed observation', terminal: false, bad: false }
    case 'Submitted':
      return { note: 'Verifier checking evidence', terminal: false, bad: false }
    case 'Accepted':
    case 'Rejected':
      return { note: `Verdict ${st}. Challenge window open until finalize`, terminal: false, bad: false }
    case 'Challenged':
      return { note: 'Challenged: waiting for the human arbiter', terminal: false, bad: false }
    case 'Settled':
      return { note: `Settled: ${m.onchain?.outcome}`, terminal: true, bad: m.onchain?.outcome !== 'ProviderPaid' }
    case 'Expired':
      return { note: 'Expired: buyer refunded', terminal: true, bad: true }
    default:
      return { note: 'Syncing with chain', terminal: false, bad: false }
  }
}

type Prog = 'done' | 'active' | 'todo' | 'bad'
interface Lane {
  id: string
  label: string
  hue: string
  Icon: LucideIcon
  steps: { label: string; done: boolean }[]
  failed?: boolean
}

/** Per-agent progress from real facts only (persisted records and confirmed onchain status). */
export function lanesOf(m: PMission): Lane[] {
  const st = m.onchain?.status
  const settled = st === 'Settled' || st === 'Expired'
  const assigned = AFTER(st, ['Assigned', 'Submitted', 'Accepted', 'Rejected', 'Challenged', 'Settled'])
  const hasEvidence = AFTER(st, ['Submitted', 'Accepted', 'Rejected', 'Challenged', 'Settled']) && !!m.onchain?.evidenceHash && m.onchain.evidenceHash !== ZERO
  const verdictOnchain = !!m.onchain && m.onchain.decision !== 'None' && m.onchain.decision !== undefined
  const done = (k: string) => m.jobs[k]?.status === 'done'
  const blocked = m.stage === 'blocked' || m.stage === 'failed'
  return [
    {
      id: 'buyer',
      label: 'Buyer agent',
      hue: '#acc6e9',
      Icon: Coins,
      failed: blocked,
      steps: [
        { label: 'Quotes', done: m.quotes.length > 0 },
        { label: 'Decision', done: !!m.decision },
        { label: 'Funded', done: !!m.chain },
      ],
    },
    {
      id: 'provider',
      label: 'Provider agent',
      hue: '#f1c27a',
      Icon: Radar,
      steps: [
        { label: 'Accepted', done: assigned },
        { label: 'Reading', done: !!m.observation || hasEvidence },
        { label: 'Evidence', done: hasEvidence },
      ],
    },
    {
      id: 'verifier',
      label: 'Verifier agent',
      hue: '#c4b5fd',
      Icon: ScanSearch,
      steps: [
        { label: 'Checked', done: !!m.verdict || verdictOnchain },
        { label: 'Signed', done: !!m.verdict || verdictOnchain },
        { label: 'Onchain', done: verdictOnchain },
      ],
    },
    {
      id: 'keeper',
      label: 'Settlement keeper',
      hue: '#94a3b8',
      Icon: Gavel,
      steps: [
        { label: 'Settled', done: settled },
        { label: 'Reconciled', done: done('reconcile') },
        { label: 'Withdrawn', done: settled && done('reconcile') && (!m.jobs.withdraw_provider || done('withdraw_provider')) && (!m.jobs.withdraw_verifier || done('withdraw_verifier')) },
      ],
    },
  ]
}

function progOf(lane: Lane, terminalBad: boolean): Prog[] {
  let activeSet = false
  return lane.steps.map((s) => {
    if (s.done) return 'done'
    if (!activeSet) {
      activeSet = true
      return lane.failed || (terminalBad && lane.id === 'buyer') ? 'bad' : 'active'
    }
    return 'todo'
  })
}

export function AgentTrack({ m }: { m: PMission }) {
  const reduce = useReducedMotion()
  const { note, bad, terminal } = stepOf(m)
  const lanes = lanesOf(m)
  return (
    <section className="card p-4 sm:p-5" aria-label="Agent progress">
      <div className="label">Agent progress</div>
      <p className="mb-3 text-sm text-[var(--ink-2)]" aria-live="polite">
        {note}
      </p>
      <ul className="space-y-3">
        {lanes.map((lane) => {
          const prog = progOf(lane, bad && terminal && lane.id === 'buyer' && !m.chain)
          const doneCount = prog.filter((p) => p === 'done').length
          const allDone = doneCount === lane.steps.length
          const isActive = prog.includes('active')
          return (
            <li key={lane.id} className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3">
              <motion.div
                initial={false}
                animate={{ scale: isActive && !reduce ? [1, 1.07, 1] : 1 }}
                transition={isActive && !reduce ? { repeat: Infinity, duration: 1.8 } : { duration: 0 }}
                className="flex h-10 w-10 items-center justify-center rounded-xl border"
                style={{ borderColor: lane.hue, background: `${lane.hue}22`, opacity: allDone || isActive || doneCount ? 1 : 0.55 }}
                title={lane.label}
              >
                <lane.Icon size={18} aria-hidden />
              </motion.div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold" style={{ color: lane.hue }}>
                    {lane.label}
                  </span>
                  <span className="num text-[11px] text-[var(--subtle)]">
                    {doneCount}/{lane.steps.length}
                  </span>
                </div>
                <ol className="flex items-center gap-1.5">
                  {lane.steps.map((s, i) => (
                    <li key={s.label} className="min-w-0 flex-1">
                      <div className="lane-dot" aria-hidden>
                        <i
                          style={{
                            background: prog[i] === 'bad' ? 'var(--danger)' : lane.hue,
                            transform: `scaleX(${prog[i] === 'done' ? 1 : prog[i] === 'active' ? 0.38 : 0})`,
                            transitionDuration: reduce ? '0s' : undefined,
                          }}
                        />
                      </div>
                      <span className={`mt-1 flex items-center gap-1 text-[10px] ${prog[i] === 'todo' ? 'text-[var(--subtle)]' : 'text-[var(--ink-2)]'}`}>
                        {prog[i] === 'done' ? <Check size={10} aria-hidden /> : prog[i] === 'bad' ? <X size={10} aria-hidden /> : null}
                        <span className="truncate">{s.label}</span>
                        <span className="sr-only">{prog[i]}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
