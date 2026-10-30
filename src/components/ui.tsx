import type { ReactNode } from 'react'
import { ExternalLink, FlaskConical } from 'lucide-react'
import { addrUrl, short, txUrl } from '@/lib/api'

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'sim'; children: ReactNode }) {
  const tones: Record<string, string> = {
    neutral: 'border-white/15 text-[var(--ink-2)]',
    ok: 'border-[rgba(141,216,159,0.5)] text-[var(--success)]',
    warn: 'border-[rgba(241,194,122,0.5)] text-[var(--warn)]',
    bad: 'border-[rgba(232,109,122,0.5)] text-[var(--danger)]',
    sim: 'border-[rgba(241,194,122,0.6)] text-[var(--warn)] bg-[rgba(241,194,122,0.08)]',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function SimBadge({ label = 'SIMULATED' }: { label?: string }) {
  return (
    <Badge tone="sim">
      <FlaskConical size={11} aria-hidden /> {label}
    </Badge>
  )
}

export function TxLink({ chainId, hash, label }: { chainId: number; hash: string; label?: string }) {
  return (
    <a
      href={txUrl(chainId, hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="mono inline-flex items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {label ?? short(hash)} <ExternalLink size={11} aria-hidden />
    </a>
  )
}

export function AddrLink({ chainId, address }: { chainId: number; address: string }) {
  return (
    <a
      href={addrUrl(chainId, address)}
      target="_blank"
      rel="noopener noreferrer"
      className="mono inline-flex items-center gap-1 text-xs text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {short(address, 6, 4)} <ExternalLink size={11} aria-hidden />
    </a>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="display num text-xl font-semibold leading-tight">{value}</div>
      {sub ? <div className="text-xs text-[var(--subtle)]">{sub}</div> : null}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="inset p-4 text-sm text-[var(--muted)]">
      <div className="font-semibold text-[var(--ink-2)]">{title}</div>
      {children ? <div className="mt-1 text-pretty">{children}</div> : null}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-xl border border-[rgba(232,109,122,0.45)] bg-[rgba(232,109,122,0.08)] p-3 text-sm text-[var(--danger)]">
      {message}
    </div>
  )
}
