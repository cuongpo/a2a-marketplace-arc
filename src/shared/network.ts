// Pure helpers for the open agent network: profile validation, trust blending and invite matching.
// No I/O here so the server, the external runner, the UI and the tests all share one definition.
import type { AgentRecord, SignedQuote, TrustBreakdown } from './types'

export const CAPABILITIES: SignedQuote['evidenceCapability'][] = ['signed-device', 'signed-device+photo', 'field-operator']
export const CAP_SCORE: Record<SignedQuote['evidenceCapability'], number> = { 'signed-device+photo': 1, 'signed-device': 0.8, 'field-operator': 0.5 }
export const DELIVERY_TAG = 'fieldquest.delivery'
const UINT = /^\d{1,20}$/
const MAX_PRICE_CEILING = 5_000_000n // 5 USDC, the demo budget ceiling

export interface ProfileInput {
  agentId: string
  displayName: string
  capability: SignedQuote['evidenceCapability']
  minPriceUsdc: string
  maxPriceUsdc: string
  maxEtaSec: number
  cardUrl?: string
}
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Public https URLs only: no credentials, no odd ports, no IP literals, no localhost or internal names. Never fetched. */
export function isPublicHttpsUrl(raw: string): boolean {
  if (raw.length > 200) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.') || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false
  if (/\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(h)) return false
  return /^[a-z0-9.-]+$/.test(h) && /[a-z]{2,}$/.test(h)
}

export function parseProfile(body: unknown): Parsed<ProfileInput> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const agentId = typeof b.agentId === 'string' || typeof b.agentId === 'number' ? String(b.agentId) : ''
  if (!UINT.test(agentId)) return { ok: false, error: 'agentId must be the numeric ERC-8004 identity id' }
  const name = typeof b.displayName === 'string' ? b.displayName.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (name.length < 3 || name.length > 40 || /[<>\u0000-\u001f]/.test(name)) return { ok: false, error: 'displayName must be 3..40 printable characters without < or >' }
  const capability = CAPABILITIES.find((c) => c === b.capability)
  if (!capability) return { ok: false, error: `capability must be one of ${CAPABILITIES.join(', ')}` }
  const min = typeof b.minPriceUsdc === 'string' ? b.minPriceUsdc : ''
  const max = typeof b.maxPriceUsdc === 'string' ? b.maxPriceUsdc : ''
  if (!UINT.test(min) || !UINT.test(max)) return { ok: false, error: 'prices are USDC base units (6 decimals) as decimal strings' }
  if (BigInt(min) < 1n || BigInt(max) < BigInt(min) || BigInt(max) > MAX_PRICE_CEILING) return { ok: false, error: 'need 1 <= minPriceUsdc <= maxPriceUsdc <= 5000000 base units' }
  const eta = b.maxEtaSec
  if (typeof eta !== 'number' || !Number.isInteger(eta) || eta < 60 || eta > 86_400) return { ok: false, error: 'maxEtaSec must be an integer from 60 to 86400' }
  let cardUrl: string | undefined
  if (b.cardUrl !== undefined && b.cardUrl !== '') {
    if (typeof b.cardUrl !== 'string' || !isPublicHttpsUrl(b.cardUrl)) return { ok: false, error: 'cardUrl must be a public https URL (no credentials, IP literal, localhost or internal host)' }
    cardUrl = b.cardUrl
  }
  return { ok: true, value: { agentId, displayName: name, capability, minPriceUsdc: min, maxPriceUsdc: max, maxEtaSec: eta, cardUrl } }
}

/** Standards-shaped ERC-8004 registration metadata as a data URI. This is NOT a full A2A Agent Card. */
export function registrationDataUri(opts: { name: string; capability: string; chainId: number; identityRegistry: string; agentId?: string; active?: boolean }): string {
  const doc: Record<string, unknown> = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: opts.name,
    description: `A2A Marketplace provider (${opts.capability}). Sells signed data readings; settles in escrowed USDC on Arc.`,
    services: [],
    x402Support: false,
    active: opts.active ?? true,
  }
  if (opts.agentId !== undefined) doc.registrations = [{ agentId: Number(opts.agentId), agentRegistry: `eip155:${opts.chainId}:${opts.identityRegistry}` }]
  const json = JSON.stringify(doc)
  return `data:application/json;base64,${typeof Buffer !== 'undefined' ? Buffer.from(json).toString('base64') : btoa(json)}`
}

/**
 * Blend local verified escrow history with adapter-filtered ERC-8004 reputation.
 * Both are Laplace-smoothed delivery rates. The onchain weight grows with its own sample size (n / (n + 2)) so a
 * single onchain record cannot dominate, and it is exactly 0 when the registry is unavailable or the identity is not
 * trusted, which degrades to local history. NOTE: both signals derive from the same escrow outcomes, so the blend
 * widens coverage (missions this server never saw) rather than adding independent evidence.
 */
export function blendTrust(
  local: { ok: number; total: number },
  onchain: { available: boolean; count: number; avgValue?: number; reason?: string; agentId?: string },
): TrustBreakdown {
  const localScore = (local.ok + 1) / (local.total + 2)
  const usable = onchain.available && onchain.count > 0 && onchain.avgValue !== undefined
  let onScore: number | undefined
  let wOn = 0
  if (usable) {
    const rate = Math.min(1, Math.max(0, (onchain.avgValue as number) / 100))
    onScore = (rate * onchain.count + 1) / (onchain.count + 2)
    wOn = onchain.count / (onchain.count + 2)
  }
  const blended = (1 - wOn) * localScore + wOn * (onScore ?? 0)
  return {
    local: { ...local, score: Number(localScore.toFixed(4)) },
    onchain: { ...onchain, score: onScore === undefined ? undefined : Number(onScore.toFixed(4)) },
    weights: { local: Number((1 - wOn).toFixed(4)), onchain: Number(wOn.toFixed(4)) },
    blended: Number(blended.toFixed(4)),
    sampleCount: local.total + (usable ? onchain.count : 0),
    note: usable
      ? 'Blend of local escrow history and ERC-8004 feedback posted by the marketplace adapter. Reputation is a signal, not proof of truth.'
      : onchain.reason ?? 'No onchain reputation counted; using local escrow history (neutral 0.5 for a new agent).',
  }
}

export const INVITE_W = { trust: 0.4, capability: 0.25, price: 0.2, eta: 0.15 }
export function matchInvite(
  agent: Pick<AgentRecord, 'capability' | 'minPriceUsdc' | 'maxPriceUsdc' | 'maxEtaSec' | 'displayName'>,
  mission: { availBudget: bigint; secondsLeft: number },
  trust: number,
): { eligible: boolean; score: number; reasons: string[] } {
  const reasons: string[] = []
  const min = BigInt(agent.minPriceUsdc)
  if (min > mission.availBudget) return { eligible: false, score: 0, reasons: [`least price ${min} exceeds the provider budget ${mission.availBudget}`] }
  if (agent.maxEtaSec > mission.secondsLeft - 60) return { eligible: false, score: 0, reasons: [`needs up to ${agent.maxEtaSec}s but only ${Math.max(0, mission.secondsLeft - 60)}s remain`] }
  const cap = CAP_SCORE[agent.capability]
  const price = Math.max(0, 1 - Number(min) / Math.max(1, Number(mission.availBudget)))
  const eta = Math.max(0, 1 - agent.maxEtaSec / Math.max(1, mission.secondsLeft))
  const score = INVITE_W.trust * trust + INVITE_W.capability * cap + INVITE_W.price * price + INVITE_W.eta * eta
  reasons.push(`fits budget (floor ${min} of ${mission.availBudget})`, `ETA up to ${agent.maxEtaSec}s within ${mission.secondsLeft}s`, `${agent.capability} evidence`, `trust ${trust.toFixed(2)}`)
  return { eligible: true, score: Number(score.toFixed(4)), reasons }
}
