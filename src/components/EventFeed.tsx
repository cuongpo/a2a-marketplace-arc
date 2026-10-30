import { Activity } from 'lucide-react'
import { ago, useApi, type FeedItem, type Overview } from '@/lib/api'
import { Empty, TxLink } from './ui'

const AGENT: Record<string, string> = {
  buyer: 'Buyer',
  provider: 'Provider',
  verifier: 'Verifier',
  keeper: 'Keeper',
  arbiter: 'Arbiter',
  operator: 'Operator',
  system: 'System',
}

export function EventFeed({ ov }: { ov: Overview | null }) {
  const { data, error, loading } = useApi<FeedItem[]>('/feed', 3000)
  return (
    <section className="card p-4 sm:p-5" aria-label="Agent audit trail and live events">
      <div className="mb-2 flex items-center gap-2">
        <Activity size={16} aria-hidden />
        <div className="label">Live audit trail: agent decisions, wallet actions, failures</div>
      </div>
      {error ? <p className="text-xs text-[var(--danger)]">Feed unavailable: {error}</p> : null}
      {loading && !data ? <p className="text-sm text-[var(--subtle)]">Loading...</p> : null}
      {data && data.length === 0 ? <Empty title="Nothing has happened yet">Open a mission on any fogged tile and the agents will start working.</Empty> : null}
      <ul className="max-h-[380px] space-y-2 overflow-y-auto pr-1" aria-live="polite">
        {data?.map((e, i) => (
          <li key={`${e.at}-${i}`} className="border-l-2 pl-3 text-xs" style={{ borderColor: e.level === 'error' ? 'var(--danger)' : e.level === 'warn' ? 'var(--warn)' : 'var(--border)' }}>
            <div className="flex flex-wrap items-center gap-2 text-[var(--subtle)]">
              <span className="font-semibold text-[var(--ink-2)]">{AGENT[e.agent] ?? e.agent}</span>
              <span>tile {e.tile}</span>
              <span>{ago(e.at)}</span>
              {e.data?.txHash && ov ? <TxLink chainId={ov.chainId} hash={e.data.txHash} /> : null}
            </div>
            <div className="text-[var(--muted)] text-pretty">{e.message}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
