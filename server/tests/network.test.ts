import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

const dir = mkdtempSync(join(tmpdir(), 'fq-net-test-'))
process.env.FQ_DATA_DIR = dir
process.env.FQ_ENABLE_FIXTURE = '1'
process.env.FQ_VERIFIER_KEY ??= generatePrivateKey()
process.env.FQ_SENSOR_KEY ??= generatePrivateKey()
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const { handle, deps } = await import('../http')
const { resetAuthForTests } = await import('../auth')
const { agentDirectory, missions, runJob, reliabilityOf } = await import('../store')
const { netDeps, resetNetworkCaches, liveNetworkDeps, trustFor, computeInvites, verifyIdentity, registerAgent } = await import('../network')
const { createMission, submitQuote } = await import('../pipeline')
const { decide } = await import('../agents/buyer')
const { feedbackDeps, feedbackEnabledFor, parseFeedbackLogs, recordFeedback } = await import('../feedback')
const { publicClient, requireDeployment } = await import('../chain')
const { hashRequestBody } = await import('../../src/shared/canonical')
const { apiAuthDomain, apiAuthTypes, quoteDomain, quoteTypes, tileIdOf } = await import('../../src/shared/typed')
const { blendTrust, isPublicHttpsUrl, parseProfile } = await import('../../src/shared/network')
const { erc8004AdapterAbi } = await import('../../src/shared/abis')
type Challenge = import('../../src/shared/typed').ApiChallenge

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const wallet = () => privateKeyToAccount(generatePrivateKey())

/** Fake ERC-8004 world: which id each wallet bound in the adapter, who owns each token, and adapter-filtered feedback. */
const world = {
  bound: new Map<string, bigint>(),
  owner: new Map<string, string>(),
  rep: new Map<string, { count: number; avgValue: number | undefined } | 'down'>(),
}
const bindIdentity = (w: Address, id: bigint) => {
  world.bound.set(w.toLowerCase(), id)
  world.owner.set(id.toString(), w)
}

beforeEach(() => {
  resetAuthForTests()
  resetNetworkCaches()
  world.bound.clear()
  world.owner.clear()
  world.rep.clear()
  for (const a of agentDirectory.all()) a.active = false
  for (const m of missions.all()) m.stage = 'settled'
  netDeps.current = {
    adapterIdentity: (w) => Promise.resolve({ agentId: world.bound.get(w.toLowerCase()) ?? 0n, bound: world.bound.has(w.toLowerCase()) }),
    ownerOf: (id) => {
      const o = world.owner.get(id.toString())
      return o ? Promise.resolve(o as Address) : Promise.reject(new Error('nonexistent token'))
    },
    reputation: (id) => {
      const r = world.rep.get(id.toString())
      if (r === 'down') return Promise.reject(new Error('registry down'))
      return Promise.resolve(r ?? { count: 0, avgValue: undefined })
    },
    nowSec: () => Math.floor(Date.now() / 1000),
  }
  deps.kick = () => undefined
})

const url = (p: string) => `http://localhost/api${p}`
async function signedPost(acct: PrivateKeyAccount, path: string, body: unknown) {
  const ch = await handle(new Request(url('/auth/challenge'), { method: 'POST', body: JSON.stringify({ method: 'POST', path, bodyHash: hashRequestBody(body) }) }))
  const c = (await ch.json()) as Challenge
  const signature = await acct.signTypedData({
    domain: apiAuthDomain(c.chainId), types: apiAuthTypes, primaryType: 'ApiRequest',
    message: { statement: c.statement, method: c.method, path: c.path, bodyHash: c.bodyHash, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt) },
  })
  const res = await handle(new Request(url(path), { method: 'POST', headers: { authorization: `A2AMarket nonce=${c.nonce}, signature=${signature}` }, body: JSON.stringify(body) }))
  return { res, json: (await res.json()) as Record<string, unknown> }
}
const profile = (agentId: bigint | number | string, extra: Record<string, unknown> = {}) => ({
  agentId: String(agentId), displayName: 'Delta Gauge Co-op', capability: 'signed-device', minPriceUsdc: '100000', maxPriceUsdc: '600000', maxEtaSec: 900, ...extra,
})

describe('agent registration authorization', () => {
  test('an unsigned registration is rejected and stores nothing', async () => {
    const before = agentDirectory.all().length
    const res = await handle(new Request(url('/agents'), { method: 'POST', body: JSON.stringify(profile(1)) }))
    expect(res.status).toBe(401)
    expect(agentDirectory.all().length).toBe(before)
  })

  test('a signed registration is stored under the SIGNER wallet, with safe public metadata only', async () => {
    const w = wallet()
    bindIdentity(w.address, 11n)
    const { res, json } = await signedPost(w, '/agents', profile(11, { wallet: '0x000000000000000000000000000000000000dEaD', privateKey: '0xdead' }))
    expect(res.status).toBe(201)
    expect(same(json.wallet as string, w.address)).toBe(true)
    const rec = agentDirectory.get(w.address)!
    expect(rec.agentId).toBe('11')
    expect(JSON.stringify(rec)).not.toContain('dEaD')
    expect(JSON.stringify(rec)).not.toContain('privateKey')
    expect(rec.registrationUri.startsWith('data:application/json;base64,')).toBe(true)
    expect(rec.ownerHistory.length).toBe(1)
  })

  test('spoofed identity: a wallet cannot register an id owned by someone else', async () => {
    const attacker = wallet()
    const victim = wallet()
    bindIdentity(victim.address, 21n)
    world.bound.set(attacker.address.toLowerCase(), 21n) // attacker bound the victim's id in the adapter (bindAgent would revert; fake it)
    const { res, json } = await signedPost(attacker, '/agents', profile(21))
    expect(res.status).toBe(403)
    expect(String(json.error)).toMatch(/owned by another wallet/)
    expect(agentDirectory.get(attacker.address)).toBeUndefined()
  })

  test('the id in the body must equal the adapter binding, and an unbound wallet is refused', async () => {
    const w = wallet()
    const unbound = await signedPost(w, '/agents', profile(5))
    expect(unbound.res.status).toBe(403)
    expect(String(unbound.json.error)).toMatch(/not bound/)
    bindIdentity(w.address, 31n)
    const wrong = await signedPost(w, '/agents', profile(32))
    expect(wrong.res.status).toBe(403)
    expect(String(wrong.json.error)).toMatch(/not #32/)
  })

  test('duplicate ids conflict; a moved identity can be re-registered but loses inherited reputation', async () => {
    const a = wallet()
    const b = wallet()
    bindIdentity(a.address, 41n)
    expect((await signedPost(a, '/agents', profile(41))).res.status).toBe(201)
    world.bound.set(b.address.toLowerCase(), 41n)
    const dup = await signedPost(b, '/agents', profile(41)) // a still owns token 41: b cannot pass the ownership check
    expect(dup.res.status).toBe(403)
    expect(agentDirectory.get(b.address)).toBeUndefined()
    // token moves to b, b rebinds in the adapter and registers
    world.owner.set('41', b.address)
    resetNetworkCaches()
    const moved = await signedPost(b, '/agents', profile(41))
    expect(moved.res.status).toBe(201)
    expect(agentDirectory.get(a.address)!.active).toBe(false)
    expect(agentDirectory.get(a.address)!.supersededBy).toBe(b.address)
    expect(agentDirectory.get(b.address)!.ownerHistory.length).toBe(2)
    world.rep.set('41', { count: 9, avgValue: 100 })
    const t = await trustFor(b.address)
    expect(t.onchain.available).toBe(false) // identity changed hands: no inherited reputation
    expect(t.weights.onchain).toBe(0)
  })

  test('the identity id is immutable per wallet and a wallet can deactivate only itself', async () => {
    const w = wallet()
    const other = wallet()
    bindIdentity(w.address, 51n)
    expect((await signedPost(w, '/agents', profile(51))).res.status).toBe(201)
    world.bound.set(w.address.toLowerCase(), 52n)
    world.owner.set('52', w.address)
    expect((await signedPost(w, '/agents', profile(52))).res.status).toBe(409)
    expect((await signedPost(other, '/agents', { active: false })).res.status).toBe(404) // not in directory: cannot touch w
    expect(agentDirectory.get(w.address)!.active).toBe(true)
    const off = await signedPost(w, '/agents', { active: false })
    expect(off.res.status).toBe(201)
    expect(agentDirectory.get(w.address)!.active).toBe(false)
  })

  test('profile validation: lengths, ranges and URLs (never fetched; no private or local hosts)', () => {
    expect(parseProfile(profile(1)).ok).toBe(true)
    expect(parseProfile(profile(1, { displayName: 'ab' })).ok).toBe(false)
    expect(parseProfile(profile(1, { displayName: '<script>' })).ok).toBe(false)
    expect(parseProfile(profile(1, { capability: 'telepathy' })).ok).toBe(false)
    expect(parseProfile(profile(1, { minPriceUsdc: '700000' })).ok).toBe(false) // min > max
    expect(parseProfile(profile(1, { maxPriceUsdc: '9000000' })).ok).toBe(false)
    expect(parseProfile(profile(1, { maxEtaSec: 5 })).ok).toBe(false)
    for (const bad of ['http://example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://user:pw@example.com/a', 'https://example.com:8443/a', 'https://printer.local/a', 'https://[::1]/a', 'https://intranet/a'])
      expect(isPublicHttpsUrl(bad)).toBe(false)
    expect(isPublicHttpsUrl('https://agents.example.org/card.json')).toBe(true)
    expect(parseProfile(profile(1, { cardUrl: 'https://agents.example.org/card.json' })).ok).toBe(true)
    expect(parseProfile(profile(1, { cardUrl: 'http://evil.test/x' })).ok).toBe(false)
  })
})

async function activeAgent(id: bigint, over: Partial<ReturnType<typeof profile>> = {}) {
  const w = wallet()
  bindIdentity(w.address, id)
  await registerAgent(w.address, { ...profile(id), ...over })
  return w
}
const customMission = (tile: string, budget = '1') => createMission({ tile, scenario: 'custom', budgetUsdc: budget, deadlineMinutes: 30, operator: wallet().address })

describe('invitation matching', () => {
  test('matches capability, budget, ETA and verified identity; snapshots invites and skip reasons', async () => {
    const good = await activeAgent(101n)
    const cheapFloor = await activeAgent(102n, { minPriceUsdc: '2000000', maxPriceUsdc: '3000000' }) // floor above the 1 USDC budget
    const slow = await activeAgent(103n, { maxEtaSec: 86_000 }) // cannot finish within 30 minutes
    const moved = await activeAgent(104n)
    world.owner.set('104', wallet().address) // token transferred away after registration
    resetNetworkCaches()
    const m = customMission('F3')
    await computeInvites(m)
    const invited = m.invites!.entries.map((e) => e.wallet.toLowerCase())
    expect(invited).toContain(good.address.toLowerCase())
    for (const w of [cheapFloor, slow, moved]) expect(invited).not.toContain(w.address.toLowerCase())
    const reasons = m.invites!.skipped.map((s) => s.reason).join(' | ')
    expect(reasons).toMatch(/exceeds the provider budget/)
    expect(reasons).toMatch(/remain/)
    expect(reasons).toMatch(/owned by another wallet/)
    expect(m.invites!.entries[0].reasons.length).toBeGreaterThan(0)
    expect(m.invites!.considered).toBeGreaterThanOrEqual(4)
  })

  test('deactivated agents are not invited, and invites persist on the mission', async () => {
    const w = await activeAgent(111n)
    const rec = agentDirectory.get(w.address)!
    rec.active = false
    const m = customMission('F4')
    await computeInvites(m)
    expect(m.invites!.entries.some((e) => same(e.wallet, w.address))).toBe(false)
    expect(missions.get(m.id)!.invites).toBeDefined()
  })

  test('a token transfer invalidates a cached identity before invitations are sent', async () => {
    const w = await activeAgent(115n)
    expect((await verifyIdentity(w.address, '115')).ok).toBe(true)
    world.owner.set('115', wallet().address)
    const m = customMission('D3')
    await computeInvites(m)
    expect(m.invites!.entries.some((e) => same(e.wallet, w.address))).toBe(false)
    expect(m.invites!.skipped.some((e) => same(e.wallet, w.address) && /owned by another wallet/.test(e.reason))).toBe(true)
  })

  test('invitations are recommendations: an uninvited wallet with a valid signed quote may still bid', async () => {
    const m = customMission('E4')
    await computeInvites(m) // nobody registered: empty snapshot
    expect(m.invites!.entries.length).toBe(0)
    const stranger = wallet()
    const validUntil = m.quoteDeadlineUnix! + 120
    const signature = await stranger.signTypedData({
      domain: quoteDomain(5042002), types: quoteTypes, primaryType: 'Quote',
      message: { provider: stranger.address, specHash: m.specHash, tileId: tileIdOf('E4'), priceUsdc: 300000n, etaSec: 600n, validUntil: BigInt(validUntil), capability: 'field-operator' },
    })
    await submitQuote(m, { provider: stranger.address, providerName: 'Uninvited Co', priceUsdc: '300000', etaSec: 600, evidenceCapability: 'field-operator', validUntil, signature, specHash: m.specHash, tileId: tileIdOf('E4') }, stranger.address)
    expect(m.quotes.length).toBe(1)
  })
})

describe('trust: adapter-filtered, blended and gracefully degrading', () => {
  test('cold start is neutral and exposes every component', async () => {
    const t = await trustFor(wallet().address)
    expect(t.blended).toBe(0.5)
    expect(t.weights).toEqual({ local: 1, onchain: 0 })
    expect(t.sampleCount).toBe(0)
  })

  test('onchain reputation only counts for a verified identity, and shifts the blend with sample size', async () => {
    const w = wallet()
    bindIdentity(w.address, 201n)
    world.rep.set('201', { count: 8, avgValue: 100 })
    const t = await trustFor(w.address)
    expect(t.onchain.available).toBe(true)
    expect(t.onchain.count).toBe(8)
    expect(t.weights.onchain).toBeCloseTo(0.8, 4)
    expect(t.blended).toBeGreaterThan(0.8)
    // same registry data, but the token is owned by someone else now: not counted
    world.owner.set('201', wallet().address)
    resetNetworkCaches()
    const spoof = await trustFor(w.address)
    expect(spoof.onchain.available).toBe(false)
    expect(spoof.blended).toBe(0.5)
  })

  test('an unavailable registry degrades to local escrow history and never throws', async () => {
    const w = wallet()
    bindIdentity(w.address, 211n)
    world.rep.set('211', 'down')
    const t = await trustFor(w.address)
    expect(t.onchain.available).toBe(false)
    expect(t.onchain.reason).toMatch(/unavailable/)
    expect(t.blended).toBe(0.5)
  })

  test('blendTrust: bad feedback lowers the score; a single record cannot dominate', () => {
    const bad = blendTrust({ ok: 0, total: 0 }, { available: true, count: 4, avgValue: 0 })
    expect(bad.blended).toBeLessThan(0.3)
    const one = blendTrust({ ok: 0, total: 0 }, { available: true, count: 1, avgValue: 100 })
    expect(one.weights.onchain).toBeCloseTo(1 / 3, 3)
    expect(one.blended).toBeLessThan(0.8)
  })

  test('the registry is queried ONLY for feedback posted by our adapter, tag fieldquest.delivery', async () => {
    const dep = requireDeployment()
    const calls: { fn: string; args: readonly unknown[] }[] = []
    const original = publicClient.readContract
    ;(publicClient as { readContract: unknown }).readContract = (req: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ fn: req.functionName, args: req.args })
      if (req.functionName === 'getSummary') return Promise.resolve([2n, 100n, 0])
      if (req.functionName === 'readAllFeedback') return Promise.resolve([[dep.adapter, dep.adapter], [1n, 2n], [100n, 0n], [0, 0], ['fieldquest.delivery', 'fieldquest.delivery'], ['paid', 'refunded'], [false, false]])
      return Promise.reject(new Error('unexpected read'))
    }
    try {
      const r = await liveNetworkDeps.reputation(77n)
      expect(r.count).toBe(2)
      expect(r.avgValue).toBe(50) // exact mean of the two adapter-posted values, not the registry's ambiguous summary
    } finally {
      ;(publicClient as { readContract: unknown }).readContract = original
    }
    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect((c.args[1] as Address[]).map((a) => a.toLowerCase())).toEqual([dep.adapter!.toLowerCase()])
      expect(c.args[2]).toBe('fieldquest.delivery')
    }
  })

  test('buyer ranking uses trust: equal bids, the agent with adapter-posted delivery history wins; components are recorded', async () => {
    const a = wallet()
    const b = wallet()
    bindIdentity(a.address, 301n)
    bindIdentity(b.address, 302n)
    world.rep.set('301', { count: 6, avgValue: 100 })
    world.rep.set('302', { count: 6, avgValue: 0 })
    const m = customMission('D4')
    for (const w of [a, b]) {
      const validUntil = m.quoteDeadlineUnix! + 120
      const signature = await w.signTypedData({
        domain: quoteDomain(5042002), types: quoteTypes, primaryType: 'Quote',
        message: { provider: w.address, specHash: m.specHash, tileId: tileIdOf('D4'), priceUsdc: 300000n, etaSec: 600n, validUntil: BigInt(validUntil), capability: 'field-operator' },
      })
      await submitQuote(m, { provider: w.address, providerName: w === a ? 'Trusted Agent' : 'Poor Agent', priceUsdc: '300000', etaSec: 600, evidenceCapability: 'field-operator', validUntil, signature, specHash: m.specHash, tileId: tileIdOf('D4') }, w.address)
    }
    m.quoteDeadlineUnix = Math.floor(Date.now() / 1000) - 1
    await decide(m)
    const top = m.decision!.scored[0]
    expect(same(top.quote.provider, a.address)).toBe(true)
    expect(top.parts.trust!.onchain.count).toBe(6)
    expect(top.parts.trust!.weights.onchain).toBeGreaterThan(0.7)
    expect(m.decision!.rationale).toMatch(/ERC-8004 feedback posted by the marketplace adapter/)
    const loser = m.decision!.scored[1]
    expect(top.score).toBeGreaterThan(loser.score)
  })

  test('scoring re-checks identity freshly: a transfer after the cache was warmed removes the onchain trust', async () => {
    const a = wallet()
    const b = wallet()
    bindIdentity(a.address, 311n)
    bindIdentity(b.address, 312n)
    world.rep.set('311', { count: 6, avgValue: 100 })
    world.rep.set('312', { count: 6, avgValue: 100 })
    const warm = await trustFor(a.address) // caches a verified identity for #311
    expect(warm.onchain.available).toBe(true)
    world.owner.set('311', wallet().address) // the identity token moves away before scoring
    const m = customMission('C1')
    for (const w of [a, b]) {
      const validUntil = m.quoteDeadlineUnix! + 120
      const signature = await w.signTypedData({
        domain: quoteDomain(5042002), types: quoteTypes, primaryType: 'Quote',
        message: { provider: w.address, specHash: m.specHash, tileId: tileIdOf('C1'), priceUsdc: 300000n, etaSec: 600n, validUntil: BigInt(validUntil), capability: 'field-operator' },
      })
      await submitQuote(m, { provider: w.address, providerName: w === a ? 'Moved Agent' : 'Stable Agent', priceUsdc: '300000', etaSec: 600, evidenceCapability: 'field-operator', validUntil, signature, specHash: m.specHash, tileId: tileIdOf('C1') }, w.address)
    }
    m.quoteDeadlineUnix = Math.floor(Date.now() / 1000) - 1
    await decide(m)
    const moved = m.decision!.scored.find((e) => same(e.quote.provider, a.address))!
    const stable = m.decision!.scored.find((e) => same(e.quote.provider, b.address))!
    expect(moved.parts.trust!.onchain.available).toBe(false)
    expect(stable.parts.trust!.onchain.available).toBe(true)
    expect(same(m.decision!.scored[0].quote.provider, b.address)).toBe(true)
  })

  test('only final escrow outcomes are counted: paid is a success, refunds and overturned verdicts are not, open missions are ignored', () => {
    const p = wallet().address
    const mk = (tile: string, stage: 'settled' | 'expired' | 'awaiting_observation', chainOutcome: number | undefined, decision?: 'accept' | 'reject') => {
      const m = customMission(tile)
      Object.assign(m, { chain: { provider: p }, stage, chainOutcome, verdict: decision ? { decision } : undefined })
      return m
    }
    mk('C2', 'settled', 1, 'accept') // paid
    mk('C3', 'settled', 2, 'reject') // refunded
    mk('B1', 'settled', 2, 'accept') // verifier accepted but the arbiter overturned it: not a success
    mk('B4', 'expired', 4) // never delivered
    mk('D1', 'awaiting_observation', undefined, 'accept') // still open: ignored
    const r = reliabilityOf(p)
    expect(r.total).toBe(4)
    expect(r.ok).toBe(1)
    expect(r.score).toBeCloseTo(2 / 6, 5)
  })
})

/** A receipt whose logs are real adapter events, so the parser is exercised against the real ABI encoding. */
function receiptWith(logs: { event: 'FeedbackRecorded' | 'FeedbackFailed'; agentId: bigint; role: number; value?: bigint }[], adapter: Address): TransactionReceipt {
  return {
    status: 'success', blockNumber: 1n, transactionHash: ('0x' + '11'.repeat(32)) as Hex,
    logs: logs.map((l, i) => ({
      address: adapter, blockNumber: 1n, logIndex: i, transactionIndex: 0, removed: false, transactionHash: ('0x' + '11'.repeat(32)) as Hex, blockHash: ('0x' + '22'.repeat(32)) as Hex,
      topics: encodeEventTopics({ abi: erc8004AdapterAbi, eventName: l.event, args: { missionId: 9n, agentId: l.agentId, role: l.role } }) as [Hex, ...Hex[]],
      data: l.event === 'FeedbackRecorded' ? encodeAbiParameters([{ type: 'int128' }], [l.value ?? 0n]) : '0x',
    })),
  } as unknown as TransactionReceipt
}

describe('ERC-8004 feedback keeper job', () => {
  const providerW = wallet().address
  const verifierW = wallet().address
  function fundedMission(tile: string) {
    const m = customMission(tile)
    m.chain = { chainId: 5042002, escrow: requireDeployment().escrow, onchainId: '9', provider: providerW, verifier: verifierW, providerPrice: '300000', verifierFee: '50000', deadline: m.spec.deadlineUnix, createdBlock: '1', createdAtChain: 1 }
    m.stage = 'settled'
    return m
  }
  let sends = 0
  const fake = (over: Partial<typeof feedbackDeps.current> = {}, receipt?: TransactionReceipt) => {
    sends = 0
    const bound = new Map<string, bigint>([[providerW.toLowerCase(), 7n], [verifierW.toLowerCase(), 8n]])
    feedbackDeps.current = {
      identityOf: (w) => Promise.resolve({ agentId: bound.get(w.toLowerCase()) ?? 0n, bound: bound.has(w.toLowerCase()) }),
      recorded: () => Promise.resolve(false),
      verdictDelivered: () => Promise.resolve(true),
      record: () => {
        sends++
        return Promise.resolve({ hash: ('0x' + 'ab'.repeat(32)) as Hex, receipt: receipt ?? receiptWith([], requireDeployment().adapter!) })
      },
      wait: () => Promise.resolve(receipt ?? receiptWith([], requireDeployment().adapter!)),
      adapter: () => requireDeployment().adapter!,
      ...over,
    }
  }

  test('records once: the receipt logs decide what is claimed, and a second run sends nothing', async () => {
    const adapter = requireDeployment().adapter!
    fake({}, receiptWith([{ event: 'FeedbackRecorded', agentId: 7n, role: 0, value: 100n }, { event: 'FeedbackRecorded', agentId: 8n, role: 1, value: 100n }], adapter))
    const m = fundedMission('C4')
    expect(await runJob(m, 'feedback', (j, set) => recordFeedback(m, set, j.txHash))).toBe('done')
    expect(await runJob(m, 'feedback', (j, set) => recordFeedback(m, set, j.txHash))).toBe('skipped')
    await recordFeedback(m, () => undefined) // even called directly again
    expect(sends).toBe(1)
    expect(m.feedback!.status).toBe('recorded')
    expect(m.feedback!.entries).toEqual([
      { role: 'provider', agentId: '7', outcome: 'recorded', value: '100' },
      { role: 'verifier', agentId: '8', outcome: 'recorded', value: '100' },
    ])
    expect(m.feedback!.txHash).toBeDefined()
  })

  test('a registry failure is reported as failed and never claimed as reputation', async () => {
    const adapter = requireDeployment().adapter!
    fake({}, receiptWith([{ event: 'FeedbackFailed', agentId: 7n, role: 0 }, { event: 'FeedbackFailed', agentId: 8n, role: 1 }], adapter))
    const m = fundedMission('B4')
    await recordFeedback(m, () => undefined)
    expect(m.feedback!.status).toBe('failed')
    expect(m.feedback!.entries.every((e) => e.outcome === 'failed' && e.value === undefined)).toBe(true)
    expect(m.feedback!.reason).toMatch(/escrow outcome is unaffected/)
  })

  test('partial success: only the confirmed role is claimed', async () => {
    const adapter = requireDeployment().adapter!
    fake({}, receiptWith([{ event: 'FeedbackRecorded', agentId: 7n, role: 0, value: 0n }, { event: 'FeedbackFailed', agentId: 8n, role: 1 }], adapter))
    const m = fundedMission('A4')
    await recordFeedback(m, () => undefined)
    expect(m.feedback!.status).toBe('partial')
    expect(m.feedback!.entries.find((e) => e.role === 'provider')!.value).toBe('0')
  })

  test('a partial receipt retries only the missing role and keeps both transaction proofs', async () => {
    const adapter = requireDeployment().adapter!
    const first = receiptWith([{ event: 'FeedbackRecorded', agentId: 7n, role: 0, value: 100n }, { event: 'FeedbackFailed', agentId: 8n, role: 1 }], adapter)
    const second = receiptWith([{ event: 'FeedbackRecorded', agentId: 8n, role: 1, value: 100n }], adapter)
    let attempts = 0
    fake({
      recorded: (role) => Promise.resolve(role === 'provider' && attempts > 0),
      record: (_id, onHash) => {
        attempts++
        const hash = (attempts === 1 ? '0x' + 'ab'.repeat(32) : '0x' + 'cd'.repeat(32)) as Hex
        onHash(hash)
        return Promise.resolve({ hash, receipt: attempts === 1 ? first : second })
      },
    })
    const m = fundedMission('D2')
    await recordFeedback(m, () => undefined)
    expect(m.feedback!.status).toBe('partial')
    await recordFeedback(m, () => undefined)
    expect(m.feedback!.status).toBe('recorded')
    expect(m.feedback!.entries.map((e) => `${e.role}:${e.value}`)).toEqual(['provider:100', 'verifier:100'])
    expect(m.feedback!.txHashes).toHaveLength(2)
    expect(attempts).toBe(2)
  })

  test('a failing feedback transaction cannot block reconcile or withdrawals (separate jobs)', async () => {
    fake({ record: () => Promise.reject(new Error('RPC down')) })
    const m = fundedMission('F3')
    const order: string[] = []
    await runJob(m, 'reconcile', () => Promise.resolve(void order.push('reconcile')))
    await runJob(m, 'withdraw_provider', () => Promise.resolve(void order.push('withdraw')))
    const r = await runJob(m, 'feedback', (j, set) => recordFeedback(m, set, j.txHash))
    expect(r).toBe('failed')
    expect(order).toEqual(['reconcile', 'withdraw'])
    expect(m.jobs.reconcile.status).toBe('done')
    expect(m.feedback).toBeUndefined() // nothing is claimed when the transaction never confirmed
  })

  test('unbound agents are skipped with a reason; already-recorded flags prevent a second transaction', async () => {
    fake({ identityOf: () => Promise.resolve({ agentId: 0n, bound: false }) })
    const a = fundedMission('F4')
    await recordFeedback(a, () => undefined)
    expect(a.feedback!.status).toBe('skipped')
    expect(sends).toBe(0)
    fake({ recorded: () => Promise.resolve(true) })
    const b = fundedMission('E3')
    await recordFeedback(b, () => undefined)
    expect(sends).toBe(0)
    expect(b.feedback!.status).toBe('recorded')
    expect(b.feedback!.txHash).toBeUndefined() // no tx hash is invented
  })

  test('a mission created before the feature shipped is never back-filled automatically', () => {
    const m = fundedMission('E2')
    expect(feedbackEnabledFor(m)).toBe(true)
    m.createdAt = 1
    expect(feedbackEnabledFor(m)).toBe(false)
  })

  test('parseFeedbackLogs ignores logs from other contracts', () => {
    const adapter = requireDeployment().adapter!
    const r = receiptWith([{ event: 'FeedbackRecorded', agentId: 1n, role: 0, value: 100n }], adapter)
    expect(parseFeedbackLogs(r, wallet().address).length).toBe(0)
    expect(parseFeedbackLogs(r, adapter).length).toBe(1)
  })
})

describe('identity helper', () => {
  test('never caches a transient registry failure', async () => {
    const w = wallet()
    let down = true
    netDeps.current = { ...netDeps.current, adapterIdentity: () => (down ? Promise.reject(new Error('rpc')) : Promise.resolve({ agentId: 5n, bound: true })), ownerOf: () => Promise.resolve(w.address) }
    expect((await verifyIdentity(w.address)).ok).toBe(false)
    down = false
    expect((await verifyIdentity(w.address)).ok).toBe(true)
  })
})
