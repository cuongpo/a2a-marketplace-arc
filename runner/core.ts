// External Provider Agent: decision logic with injected I/O so the critical path is unit-tested.
// The runner holds ONLY its own wallet and device keys. It never talks to the backend's keys, and the backend never
// talks to the runner: the runner PULLS invites, signs quotes and observations itself, and makes its own onchain calls.
//
// Restart safety: every send records its tx hash in `state.pending` BEFORE waiting for the receipt, and every action
// is guarded by an onchain-status predicate. After a crash the runner waits for the recorded hash and re-reads chain
// state; it only resends when the recorded transaction demonstrably did not take effect.
import type { Address, Hex } from 'viem'
import { hashCanonical } from '../src/shared/canonical'
import type { SignedQuote, SignedReadingInput } from '../src/shared/types'

export const STATUS = { None: 0, Funded: 1, Assigned: 2, Submitted: 3, Accepted: 4, Rejected: 5, Challenged: 6, Expired: 7, Settled: 8 } as const

export interface RunnerConfig {
  displayName: string
  capability: SignedQuote['evidenceCapability']
  minPriceUsdc: bigint
  maxPriceUsdc: bigint
  priceUsdc: bigint // what this runner actually quotes (clamped into [min, max] and the request budget)
  maxEtaSec: number
  etaSec: number
  cardUrl?: string
  agentId?: string // reuse an existing ERC-8004 identity owned by this wallet
  bidOnUninvited: boolean
  feedMode: 'file' | 'simulated' | 'none'
}

export interface RunnerState {
  agentId?: string // recovered from a confirmed registration, before attempting to bind
  quoted: Record<string, string> // local mission id -> quote signature
  pending: Record<string, Hex> // action key -> tx hash broadcast but not yet confirmed
  done: Record<string, Hex> // action key -> confirmed tx hash
  observation: Record<string, SignedReadingInput> // onchain id -> signed observation (re-sent verbatim)
  uploaded: Record<string, boolean>
}
export const emptyState = (): RunnerState => ({ quoted: {}, pending: {}, done: {}, observation: {}, uploaded: {} })

export interface OnchainMission {
  status: number
  provider: Address
  createdAt: bigint
  deadline: bigint
  tileId: Hex
  unit: Hex
  maxReadingAge: number
}
export interface InviteItem {
  missionId: string
  tile: string
  specHash: Hex
  budgetUsdc: string
  quoteDeadlineUnix: number
  onchainSpec: { deadlineUnix: number; tile: string }
  invited: boolean
  alreadyQuoted: boolean
}
export interface PublicMissionLite {
  id: string
  stage: string
  chain?: { onchainId: string; provider: Address }
  evidenceHash?: Hex
  spec: { tile: string }
}
export interface FeedValue {
  valueMm: number
  kind: 'field-operator-upload' | 'simulated-fixture'
  rawPayload: Record<string, unknown>
  observedAtUnix?: number
}

export interface RunnerIo {
  me: Address
  device: Address
  nowSec(): number
  log(msg: string): void
  state: RunnerState
  saveState(): void
  api: {
    get<T>(path: string): Promise<T | null> // null on 404
    post<T>(path: string, body: unknown): Promise<T> // wallet-signed by the runner's own key
  }
  chain: {
    adapterIdentity(): Promise<{ agentId: bigint; bound: boolean }>
    ownerOf(agentId: bigint): Promise<Address>
    registerIdentity(uri: string, onHash: (h: Hex) => void): Promise<{ hash: Hex; agentId: bigint }>
    registeredId(hash: Hex): Promise<bigint> // decode the Registered event from a confirmed prior transaction
    bind(agentId: bigint, onHash: (h: Hex) => void): Promise<Hex>
    signerInfo(device: Address): Promise<{ provider: Address; active: boolean }>
    registerSigner(onHash: (h: Hex) => void): Promise<Hex>
    mission(id: bigint): Promise<OnchainMission>
    wait(hash: Hex): Promise<'success' | 'reverted' | 'unknown'>
    accept(id: bigint, onHash: (h: Hex) => void): Promise<Hex>
    submitEvidence(id: bigint, evidenceHash: Hex, obs: SignedReadingInput, onHash: (h: Hex) => void): Promise<Hex>
    credits(): Promise<bigint>
    withdraw(onHash: (h: Hex) => void): Promise<Hex>
    verifierFeeUsdc(): bigint
  }
  signQuote(q: { specHash: Hex; tileId: Hex; priceUsdc: bigint; etaSec: number; validUntil: number; capability: SignedQuote['evidenceCapability'] }): Promise<Hex>
  signReading(r: SignedReadingInput['reading']): Promise<Hex>
  tileIdOf(tile: string): Hex
  registrationUri(agentId?: string): string
  feed(tile: string): Promise<FeedValue | null>
  nonce(): string
}

/** Run `send` once per action key: confirms a previously broadcast hash first and never resends if it took effect. */
async function once(io: RunnerIo, key: string, effective: () => Promise<boolean>, send: (onHash: (h: Hex) => void) => Promise<Hex>): Promise<'done' | 'waiting'> {
  if (io.state.done[key]) return 'done'
  const prior = io.state.pending[key]
  if (prior) {
    const r = await io.chain.wait(prior)
    if (r === 'unknown') return 'waiting' // not mined yet: do NOT resend
    delete io.state.pending[key]
    if (r === 'success') {
      io.state.done[key] = prior
      io.saveState()
      return 'done'
    }
    io.saveState() // reverted: fall through and re-check chain state
  }
  if (await effective()) {
    io.state.done[key] ??= '0x' as Hex
    io.saveState()
    return 'done'
  }
  const hash = await send((h) => {
    io.state.pending[key] = h
    io.saveState()
  })
  delete io.state.pending[key]
  io.state.done[key] = hash
  io.saveState()
  return 'done'
}

export async function setup(io: RunnerIo, cfg: RunnerConfig): Promise<string> {
  let ident = await io.chain.adapterIdentity()
  if (!ident.bound) {
    let agentId = cfg.agentId ? BigInt(cfg.agentId) : io.state.agentId ? BigInt(io.state.agentId) : undefined
    if (cfg.agentId && io.state.agentId && BigInt(cfg.agentId) !== BigInt(io.state.agentId))
      throw new Error('configured AGENT_ID differs from the identity already registered by this runner')
    const prior = io.state.pending.identity
    if (prior) {
      const result = await io.chain.wait(prior)
      if (result === 'unknown') throw new Error(`identity registration ${prior} is still pending; refusing to register another`)
      delete io.state.pending.identity
      io.saveState()
      if (result === 'reverted') throw new Error(`identity registration ${prior} reverted; review before retrying`)
      const recovered = await io.chain.registeredId(prior)
      if (agentId !== undefined && agentId !== recovered) throw new Error('confirmed identity registration does not match configured AGENT_ID')
      agentId = recovered
      io.state.agentId = recovered.toString()
      io.saveState()
    }
    if (agentId === undefined) {
      const reg = await io.chain.registerIdentity(io.registrationUri(), (h) => {
        io.state.pending['identity'] = h
        io.saveState()
      })
      io.state.agentId = reg.agentId.toString()
      delete io.state.pending['identity']
      io.saveState()
      agentId = reg.agentId
      io.log(`registered ERC-8004 identity #${agentId} (${reg.hash})`)
    }
    const owner = await io.chain.ownerOf(agentId)
    if (owner.toLowerCase() !== io.me.toLowerCase()) throw new Error(`ERC-8004 identity #${agentId} is not owned by this wallet`)
    const bound = await once(io, 'bind', async () => {
      const current = await io.chain.adapterIdentity()
      return current.bound && current.agentId === agentId
    }, (onHash) => io.chain.bind(agentId, onHash))
    if (bound === 'waiting') throw new Error('identity binding transaction is still pending; refusing to send another')
    ident = await io.chain.adapterIdentity()
    if (!ident.bound || ident.agentId !== agentId) throw new Error('identity binding did not take effect onchain')
    io.log(`bound identity #${agentId} to the marketplace adapter`)
  } else {
    const owner = await io.chain.ownerOf(ident.agentId)
    if (owner.toLowerCase() !== io.me.toLowerCase()) throw new Error(`adapter binds #${ident.agentId} but this wallet does not own it`)
    if (cfg.agentId && BigInt(cfg.agentId) !== ident.agentId) throw new Error('configured AGENT_ID differs from the adapter binding')
    io.state.agentId = ident.agentId.toString()
    io.saveState()
  }
  const sig = await io.chain.signerInfo(io.device)
  if (sig.active && sig.provider.toLowerCase() !== io.me.toLowerCase()) throw new Error('this device key is registered to another provider; use a fresh DEVICE_KEY')
  if (!sig.active) {
    if (sig.provider !== '0x0000000000000000000000000000000000000000') throw new Error('this device key was revoked or used before; registry keys are never re-bound. Use a fresh DEVICE_KEY')
    const registered = await once(io, 'signer', async () => {
      const current = await io.chain.signerInfo(io.device)
      return current.active && current.provider.toLowerCase() === io.me.toLowerCase()
    }, (onHash) => io.chain.registerSigner(onHash))
    if (registered === 'waiting') throw new Error('reading signer registration is still pending; refusing to send another')
    const current = await io.chain.signerInfo(io.device)
    if (!current.active || current.provider.toLowerCase() !== io.me.toLowerCase()) throw new Error('reading signer registration did not take effect onchain')
    io.log(`registered device key ${io.device} for readings`)
  }
  const agentId = ident.agentId.toString()
  const body = {
    agentId,
    displayName: cfg.displayName,
    capability: cfg.capability,
    minPriceUsdc: cfg.minPriceUsdc.toString(),
    maxPriceUsdc: cfg.maxPriceUsdc.toString(),
    maxEtaSec: cfg.maxEtaSec,
    ...(cfg.cardUrl ? { cardUrl: cfg.cardUrl } : {}),
  }
  const current = await io.api.get<{ agentId: string; active: boolean; displayName: string; capability: string; minPriceUsdc: string; maxPriceUsdc: string; maxEtaSec: number; cardUrl?: string }>(`/agents/${io.me}`)
  const same = current && current.active && current.agentId === agentId && current.displayName === body.displayName && current.capability === body.capability &&
    current.minPriceUsdc === body.minPriceUsdc && current.maxPriceUsdc === body.maxPriceUsdc && current.maxEtaSec === body.maxEtaSec && (current.cardUrl ?? undefined) === cfg.cardUrl
  if (!same) {
    await io.api.post('/agents', body)
    io.log(`directory entry ${current ? 'updated' : 'created'} for agent #${agentId}`)
  }
  return agentId
}

export async function bid(io: RunnerIo, cfg: RunnerConfig): Promise<number> {
  const items = (await io.api.get<InviteItem[]>(`/invites?wallet=${io.me}${cfg.bidOnUninvited ? '&open=1' : ''}`)) ?? []
  let sent = 0
  for (const it of items) {
    if (it.alreadyQuoted || io.state.quoted[it.missionId]) continue
    if (it.quoteDeadlineUnix <= io.nowSec() + 5) continue
    const avail = BigInt(it.budgetUsdc) - io.chain.verifierFeeUsdc()
    const price = cfg.priceUsdc < cfg.minPriceUsdc ? cfg.minPriceUsdc : cfg.priceUsdc > cfg.maxPriceUsdc ? cfg.maxPriceUsdc : cfg.priceUsdc
    if (price > avail || price <= 0n) {
      io.log(`skip ${it.tile}: my price ${price} does not fit the budget ${avail}`)
      continue
    }
    if (cfg.etaSec > it.onchainSpec.deadlineUnix - io.nowSec()) {
      io.log(`skip ${it.tile}: cannot deliver within the deadline`)
      continue
    }
    const validUntil = Math.min(it.onchainSpec.deadlineUnix, it.quoteDeadlineUnix + 300)
    const tileId = io.tileIdOf(it.tile)
    const signature = await io.signQuote({ specHash: it.specHash, tileId, priceUsdc: price, etaSec: cfg.etaSec, validUntil, capability: cfg.capability })
    try {
      await io.api.post(`/missions/${it.missionId}/quotes`, {
        provider: io.me, providerName: cfg.displayName, priceUsdc: price.toString(), etaSec: cfg.etaSec, evidenceCapability: cfg.capability,
        validUntil, signature, specHash: it.specHash, tileId,
      })
      io.log(`quoted ${price} for ${it.tile} (${it.invited ? 'invited' : 'uninvited'})`)
    } catch (e) {
      // A duplicate means an earlier (possibly ambiguous) attempt already landed: treat as success.
      if (!/already submitted/i.test(e instanceof Error ? e.message : '')) throw e
    }
    io.state.quoted[it.missionId] = signature
    io.saveState()
    sent++
  }
  return sent
}

/** Advances every mission where this wallet is the bound provider by at most one step each. */
export async function fulfil(io: RunnerIo, _cfg: RunnerConfig): Promise<string[]> {
  const notes: string[] = []
  const list = (await io.api.get<PublicMissionLite[]>('/missions')) ?? []
  for (const pm of list) {
    if (!pm.chain || pm.chain.provider.toLowerCase() !== io.me.toLowerCase()) continue
    const id = BigInt(pm.chain.onchainId)
    const key = pm.chain.onchainId
    const on = await io.chain.mission(id)
    if (on.provider.toLowerCase() !== io.me.toLowerCase()) continue
    for (const k of [`accept:${key}`, `submit:${key}`]) {
      // A transaction recorded before a crash has taken effect if the chain moved past that step: close it out.
      const step = k.startsWith('accept') ? STATUS.Assigned : STATUS.Submitted
      if (io.state.pending[k] && on.status >= step) {
        io.state.done[k] = io.state.pending[k]
        delete io.state.pending[k]
        io.saveState()
      }
    }
    if (on.status === STATUS.Funded) {
      await once(io, `accept:${key}`, async () => (await io.chain.mission(id)).status >= STATUS.Assigned, (h) => io.chain.accept(id, h))
      notes.push(`#${key} accepted`)
    } else if (on.status === STATUS.Assigned) {
      if (io.nowSec() > Number(on.deadline)) continue
      let obs = io.state.observation[key]
      if (!obs) {
        const f = await io.feed(pm.spec.tile)
        if (!f) {
          notes.push(`#${key} (${pm.spec.tile}) waiting for a feed value`)
          continue
        }
        const observedAt = f.observedAtUnix ?? Math.max(Number(on.createdAt) + 1, io.nowSec() - 3)
        if (!Number.isSafeInteger(observedAt) || observedAt < Number(on.createdAt) || observedAt > io.nowSec() + 60 || io.nowSec() - observedAt > Number(on.maxReadingAge)) {
          notes.push(`#${key} (${pm.spec.tile}) waiting for a fresh feed timestamp after mission creation`)
          continue
        }
        const reading: SignedReadingInput['reading'] = {
          missionId: key, tileId: on.tileId, observedAt, value: String(f.valueMm), unit: on.unit,
          nonce: io.nonce(), payloadHash: hashCanonical(f.rawPayload),
        }
        obs = { reading, signature: await io.signReading(reading), rawPayload: f.rawPayload, kind: f.kind }
        io.state.observation[key] = obs
        io.saveState()
      }
      if (!io.state.uploaded[key] || !pm.evidenceHash) {
        await io.api.post(`/missions/${pm.id}/observation`, obs)
        io.state.uploaded[key] = true
        io.saveState()
        const fresh = await io.api.get<PublicMissionLite>(`/missions/${pm.id}`)
        if (!fresh?.evidenceHash) throw new Error('the API did not return an evidence hash after preparing evidence')
        pm.evidenceHash = fresh.evidenceHash
      }
      const evidenceHash = pm.evidenceHash
      // Never commit a hash blindly: the bundle behind it must hash to it and carry MY signer, wallet and nonce.
      const bundle = await io.api.get<{ signer: Address; provider: Address; reading: { nonce: string; missionId: string } }>(`/evidence/${evidenceHash}`)
      if (!bundle || hashCanonical(bundle) !== evidenceHash.toLowerCase() && hashCanonical(bundle) !== evidenceHash)
        throw new Error('evidence bundle does not hash to the hash the API returned; refusing to commit it onchain')
      if (bundle.signer.toLowerCase() !== io.device.toLowerCase() || bundle.provider.toLowerCase() !== io.me.toLowerCase() || bundle.reading.nonce !== obs.reading.nonce || bundle.reading.missionId !== key)
        throw new Error('evidence bundle does not carry my device, wallet and nonce; refusing to commit it onchain')
      await once(io, `submit:${key}`, async () => (await io.chain.mission(id)).status >= STATUS.Submitted, (h) => io.chain.submitEvidence(id, evidenceHash, obs, h))
      notes.push(`#${key} evidence committed`)
    }
  }
  // Settled or expired missions leave a credit for this wallet: withdraw it to itself, once per confirmed credit.
  const credit = await io.chain.credits()
  if (credit > 0n) {
    const sk = `withdraw:${credit}:${Object.keys(io.state.done).filter((k) => k.startsWith('withdraw:')).length}`
    const prior = io.state.pending['withdraw']
    if (prior) {
      const r = await io.chain.wait(prior)
      if (r !== 'unknown') {
        delete io.state.pending['withdraw']
        io.saveState()
      }
    } else {
      const h = await io.chain.withdraw((x) => {
        io.state.pending['withdraw'] = x
        io.saveState()
      })
      delete io.state.pending['withdraw']
      io.state.done[sk] = h
      io.saveState()
      notes.push(`withdrew ${credit} base units (${h})`)
    }
  }
  return notes
}

export async function tick(io: RunnerIo, cfg: RunnerConfig): Promise<string[]> {
  const notes: string[] = []
  const b = await bid(io, cfg)
  if (b) notes.push(`${b} quote(s) sent`)
  notes.push(...(await fulfil(io, cfg)))
  return notes
}
