import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUsdc } from '@/onchain-money'
import { buildAddressExplorerUrl, buildTxExplorerUrl } from '@/onchain-facts'
import type { EvidenceBundle, MissionRecord } from '@/shared/types'

export interface WalletRow {
  role: string
  label: string
  address: string
  usdc: string
}
export interface Overview {
  network: 'testnet' | 'mainnet'
  chainId: number
  explorer: string
  usdc: string
  deployed: boolean
  contracts: { registry: string; escrow: string; vault: string; adapter?: string; deployTxs?: Record<string, string> } | null
  arbiter: string | null
  buyerAgent: string | null
  fixtureEnabled: boolean
  llmConfigured: boolean
  block: string
  wallets: WalletRow[]
  vault: {
    operator: string
    policy: { executor: string; perMissionCap: string; totalCap: string; dailyCap: string; expiry: string; paused: boolean }
    available: string
    committed: string
    netSpent: string
  } | null
  escrow: { liabilities: string; usdcHeld: string } | null
  providers: { role: string; name: string; capability: string; address: string | null }[]
  verifierFeeUsdc: string
}
export interface TileCell {
  tile: string
  col: string
  row: number
  state: 'fog' | 'active' | 'revealed' | 'rejected' | 'expired' | 'blocked'
  missionId?: string
  value?: number
  simulated?: boolean
  bidCount?: number
  budgetUsdc?: string
  quoteDeadlineUnix?: number
}
export interface OnchainSnap {
  status: string
  outcome: string
  decision: string
  deadline: number
  createdAt: number
  submittedAt: number
  challengeEndsAt: number
  challengedAt: number
  evidenceHash: string
  readingCommitment: string
  providerPrice: string
  verifierFee: string
}
export type PMission = Omit<MissionRecord, 'observation'> & {
  observation?: { kind: string; simulated: boolean }
  onchain: OnchainSnap | null
  evidencePreview: EvidenceBundle | null
}
export interface FeedItem {
  at: number
  agent: string
  level: 'info' | 'warn' | 'error'
  message: string
  missionId: string
  tile: string
  data?: { txHash?: string }
}

/** Server error with the machine-readable code and, for role errors, who is allowed to act. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public required?: 'operator' | 'provider' | 'arbiter',
    public expected?: string | null,
  ) {
    super(message)
  }
}

export interface VaultInfo {
  operator: string
  policy: { executor: string; perMissionCap: string; totalCap: string; dailyCap: string; expiry: string; paused: boolean }
  available: string
  committed: string
  netSpent: string
  buyerAgent: string | null
  authorised: boolean
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; required?: 'operator' | 'provider' | 'arbiter'; expected?: string | null }
  if (!res.ok) throw new ApiError(json.error ?? `request failed (${res.status})`, res.status, json.code, json.required, json.expected)
  return json
}

/** Polls a GET endpoint. Data always comes from the backend, which reads the chain. */
export function useApi<T>(path: string | null, ms = 3000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const load = useCallback(async () => {
    if (!path) return
    try {
      const d = await api<T>(path)
      if (alive.current) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'request failed')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [path])
  useEffect(() => {
    alive.current = true
    const first = setTimeout(() => void load(), 0)
    const t = ms ? setInterval(() => void load(), ms) : undefined
    return () => {
      alive.current = false
      clearTimeout(first)
      if (t) clearInterval(t)
    }
  }, [load, ms])
  return { data, error, loading, refresh: load }
}

export const usdc = (raw: string | bigint | undefined | null) => (raw === undefined || raw === null ? '-' : formatUsdc(BigInt(raw)))
export const short = (h: string, a = 8, b = 6) => (h.length > a + b + 2 ? `${h.slice(0, a)}...${h.slice(-b)}` : h)
export const txUrl = (chainId: number, h: string) => buildTxExplorerUrl(chainId, h)
export const addrUrl = (chainId: number, a: string) => buildAddressExplorerUrl(chainId, a)
export const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}
export function navigate(path: string) {
  history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
