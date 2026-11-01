import { describe, expect, test } from 'bun:test'
import { recoverTypedDataAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { hashCanonical } from '../src/shared/canonical'
import { quoteDomain, quoteTypes, tileIdOf } from '../src/shared/typed'
import { STATUS, bid, emptyState, fulfil, setup, tick, type InviteItem, type OnchainMission, type PublicMissionLite, type RunnerConfig, type RunnerIo } from './core'

const wallet = privateKeyToAccount(generatePrivateKey())
const device = privateKeyToAccount(generatePrivateKey())
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
const cfg: RunnerConfig = {
  displayName: 'Test Runner Agent', capability: 'field-operator', minPriceUsdc: 100_000n, maxPriceUsdc: 600_000n, priceUsdc: 300_000n,
  maxEtaSec: 1800, etaSec: 600, bidOnUninvited: false, feedMode: 'file',
}

/** A fake world: the chain, the API and the runner's own keys. Counts every transaction so double-sends are visible. */
function world() {
  const w = {
    identity: { agentId: 0n, bound: false },
    signerActive: false,
    txs: [] as string[],
    posts: [] as { path: string; body: Record<string, unknown> }[],
    directory: undefined as undefined | Record<string, unknown>,
    invites: [] as InviteItem[],
    missions: [] as PublicMissionLite[],
    onchain: new Map<string, OnchainMission>(),
    bundles: new Map<string, unknown>(),
    credits: 0n,
    feedValue: null as number | null,
    feedObservedAt: undefined as number | undefined,
    waitResult: 'success' as 'success' | 'reverted' | 'unknown',
    duplicateQuote: false,
    now: 1_800_000_000,
    nonceN: 0,
  }
  const tx = (name: string, onHash: (x: Hex) => void): Hex => {
    w.txs.push(name)
    const hash = h(w.txs.length)
    onHash(hash)
    return hash
  }
  const state = emptyState()
  const io: RunnerIo = {
    me: wallet.address,
    device: device.address,
    nowSec: () => w.now,
    log: () => undefined,
    state,
    saveState: () => undefined,
    api: {
      get: (path: string) => {
        if (path.startsWith('/agents/')) return Promise.resolve((w.directory ?? null) as never)
        if (path.startsWith('/invites')) return Promise.resolve(w.invites as never)
        if (path === '/missions') return Promise.resolve(w.missions as never)
        if (path.startsWith('/missions/')) return Promise.resolve((w.missions.find((m) => path.endsWith(m.id)) ?? null) as never)
        if (path.startsWith('/evidence/')) return Promise.resolve((w.bundles.get(path.slice('/evidence/'.length)) ?? null) as never)
        return Promise.resolve(null)
      },
      post: (path: string, body: unknown) => {
        const b = body as Record<string, unknown>
        w.posts.push({ path, body: b })
        if (path === '/agents') {
          w.directory = { ...b, active: true }
        } else if (path.endsWith('/quotes')) {
          if (w.duplicateQuote) return Promise.reject(new Error('this wallet already submitted a quote'))
        } else if (path.endsWith('/observation')) {
          const m = w.missions.find((x) => path.includes(x.id))!
          const reading = (b as { reading: { nonce: string; missionId: string } }).reading
          const bundle = { signer: device.address, provider: wallet.address, reading: { nonce: reading.nonce, missionId: reading.missionId } }
          const hash = hashCanonical(bundle)
          w.bundles.set(hash, bundle)
          m.evidenceHash = hash
        }
        return Promise.resolve({} as never)
      },
    },
    chain: {
      adapterIdentity: () => Promise.resolve(w.identity),
      ownerOf: () => Promise.resolve(wallet.address),
      registerIdentity: (_uri, onHash) => {
        const hash = tx('register-identity', onHash)
        return Promise.resolve({ hash, agentId: 77n })
      },
      registeredId: () => Promise.resolve(77n),
      bind: (agentId, onHash) => {
        w.identity = { agentId, bound: true }
        return Promise.resolve(tx('bind', onHash))
      },
      signerInfo: () => Promise.resolve({ provider: w.signerActive ? wallet.address : ('0x0000000000000000000000000000000000000000'), active: w.signerActive }),
      registerSigner: (onHash) => {
        w.signerActive = true
        return Promise.resolve(tx('register-signer', onHash))
      },
      mission: (id) => Promise.resolve(w.onchain.get(id.toString())!),
      wait: () => Promise.resolve(w.waitResult),
      accept: (id, onHash) => {
        w.onchain.get(id.toString())!.status = STATUS.Assigned
        return Promise.resolve(tx('accept', onHash))
      },
      submitEvidence: (id, _e, _o, onHash) => {
        w.onchain.get(id.toString())!.status = STATUS.Submitted
        return Promise.resolve(tx('submit-evidence', onHash))
      },
      credits: () => Promise.resolve(w.credits),
      withdraw: (onHash) => {
        w.credits = 0n
        return Promise.resolve(tx('withdraw', onHash))
      },
      verifierFeeUsdc: () => 50_000n,
    },
    signQuote: (q) =>
      wallet.signTypedData({
        domain: quoteDomain(5042002), types: quoteTypes, primaryType: 'Quote',
        message: { provider: wallet.address, specHash: q.specHash, tileId: q.tileId, priceUsdc: q.priceUsdc, etaSec: BigInt(q.etaSec), validUntil: BigInt(q.validUntil), capability: q.capability },
      }),
    signReading: () => Promise.resolve(('0x' + '12'.repeat(65)) as Hex),
    tileIdOf,
    registrationUri: () => 'data:application/json;base64,e30=',
    feed: () => Promise.resolve(w.feedValue === null ? null : { valueMm: w.feedValue, kind: 'field-operator-upload' as const, observedAtUnix: w.feedObservedAt, rawPayload: { source: 'operator-supplied feed file', valueMm: w.feedValue } }),
    nonce: () => String(++w.nonceN),
  }
  return { w, io }
}

const invite = (over: Partial<InviteItem> = {}): InviteItem => ({
  missionId: 'm1', tile: 'B3', specHash: h(900), budgetUsdc: '1000000', quoteDeadlineUnix: 1_800_000_090, onchainSpec: { deadlineUnix: 1_800_001_800, tile: 'B3' }, invited: true, alreadyQuoted: false, ...over,
})
const onchain = (status: number): OnchainMission => ({ status, provider: wallet.address, createdAt: 1_799_999_000n, deadline: 1_800_001_800n, tileId: tileIdOf('B3'), unit: h(5), maxReadingAge: 1800 })
const lite = (over: Partial<PublicMissionLite> = {}): PublicMissionLite => ({ id: 'm1', stage: 'funded', chain: { onchainId: '9', provider: wallet.address }, spec: { tile: 'B3' }, ...over })

describe('onboarding', () => {
  test('registers identity, binds it, registers the device key and the directory entry; a second run does nothing', async () => {
    const { w, io } = world()
    const id = await setup(io, cfg)
    expect(id).toBe('77')
    expect(w.txs).toEqual(['register-identity', 'bind', 'register-signer'])
    expect(w.posts.map((p) => p.path)).toEqual(['/agents'])
    const body = w.posts[0].body
    expect([body.agentId, body.displayName, body.minPriceUsdc, body.maxPriceUsdc]).toEqual(['77', 'Test Runner Agent', '100000', '600000'])
    const again = await setup(io, cfg)
    expect(again).toBe('77')
    expect(w.txs.length).toBe(3)
    expect(w.posts.length).toBe(1)
  })

  test('refuses a device key already registered to another provider', async () => {
    const { w, io } = world()
    w.identity = { agentId: 5n, bound: true }
    io.chain.signerInfo = () => Promise.resolve({ provider: '0x00000000000000000000000000000000000000AA', active: true })
    await expect(setup(io, cfg)).rejects.toThrow(/another provider/)
  })

  test('recovers a confirmed identity registration after a crash without minting a second NFT', async () => {
    const { w, io } = world()
    io.state.pending.identity = h(4242)
    expect(await setup(io, cfg)).toBe('77')
    expect(w.txs).toEqual(['bind', 'register-signer'])
    expect(io.state.agentId).toBe('77')
    expect(io.state.pending.identity).toBeUndefined()
  })

  test('waits for a pending identity registration instead of sending another transaction', async () => {
    const { w, io } = world()
    io.state.pending.identity = h(4242)
    w.waitResult = 'unknown'
    await expect(setup(io, cfg)).rejects.toThrow(/still pending/)
    expect(w.txs).toEqual([])
  })

  test('recovers pending binding and signer registration without resending either', async () => {
    const { w, io } = world()
    io.state.agentId = '77'
    io.state.pending.bind = h(4242)
    io.state.pending.signer = h(4243)
    io.chain.wait = (hash) => {
      if (hash === h(4242)) w.identity = { agentId: 77n, bound: true }
      if (hash === h(4243)) w.signerActive = true
      return Promise.resolve('success')
    }
    expect(await setup(io, cfg)).toBe('77')
    expect(w.txs).toEqual([])
    expect(io.state.done.bind).toBe(h(4242))
    expect(io.state.done.signer).toBe(h(4243))
  })
})

describe('bidding', () => {
  test('sends one correctly signed quote, not two, and survives a duplicate-submit response', async () => {
    const { w, io } = world()
    w.invites = [invite()]
    expect(await bid(io, cfg)).toBe(1)
    expect(await bid(io, cfg)).toBe(0) // restart-safe memory: not re-sent
    const post = w.posts.find((p) => p.path === '/missions/m1/quotes')!
    const b = post.body as { signature: Hex; priceUsdc: string; validUntil: number; specHash: Hex; tileId: Hex; etaSec: number; evidenceCapability: 'field-operator' }
    expect(b.priceUsdc).toBe('300000')
    const signer = await recoverTypedDataAddress({
      domain: quoteDomain(5042002), types: quoteTypes, primaryType: 'Quote', signature: b.signature,
      message: { provider: wallet.address, specHash: b.specHash, tileId: b.tileId, priceUsdc: BigInt(b.priceUsdc), etaSec: BigInt(b.etaSec), validUntil: BigInt(b.validUntil), capability: b.evidenceCapability },
    })
    expect(signer).toBe(wallet.address)
    expect(b.validUntil).toBeGreaterThan(1_800_000_090) // covers bidding
    // fresh process, server says "already submitted": treated as success, not a crash
    const second = world()
    second.w.invites = [invite()]
    second.w.duplicateQuote = true
    expect(await bid(second.io, cfg)).toBe(1)
  })

  test('skips what it cannot serve: closed bidding, too small a budget, too short a deadline', async () => {
    const { w, io } = world()
    w.invites = [invite({ missionId: 'closed', quoteDeadlineUnix: 1_800_000_001 }), invite({ missionId: 'poor', budgetUsdc: '200000' }), invite({ missionId: 'rush', onchainSpec: { deadlineUnix: 1_800_000_300, tile: 'B3' } })]
    expect(await bid(io, cfg)).toBe(0)
    expect(w.posts.length).toBe(0)
  })
})

describe('fulfilment critical path', () => {
  test('preserves a source timestamp and rejects a reading from before the mission', async () => {
    const { w, io } = world()
    w.missions = [lite()]
    w.onchain.set('9', onchain(STATUS.Assigned))
    w.feedValue = 412
    w.feedObservedAt = 1_799_998_999
    expect((await fulfil(io, cfg)).join()).toMatch(/fresh feed timestamp/)
    expect(w.posts.some((p) => p.path.endsWith('/observation'))).toBe(false)
    w.feedObservedAt = 1_799_999_500
    await fulfil(io, cfg)
    const obs = w.posts.find((p) => p.path.endsWith('/observation'))!.body as { reading: { observedAt: number } }
    expect(obs.reading.observedAt).toBe(1_799_999_500)
  })

  test('accept once, pause without a feed, then upload, commit evidence once, and withdraw once', async () => {
    const { w, io } = world()
    w.missions = [lite()]
    w.onchain.set('9', onchain(STATUS.Funded))
    await tick(io, cfg)
    await tick(io, cfg)
    expect(w.txs.filter((t) => t === 'accept').length).toBe(1)

    // Assigned, no feed value: the runner pauses at the observation step and sends nothing.
    const paused = await fulfil(io, cfg)
    expect(paused.join()).toMatch(/waiting for a feed value/)
    expect(w.posts.some((p) => p.path.endsWith('/observation'))).toBe(false)
    expect(w.txs.includes('submit-evidence')).toBe(false)

    // Feed input arrives.
    w.feedValue = 412
    await fulfil(io, cfg)
    await fulfil(io, cfg)
    await fulfil(io, cfg)
    expect(w.posts.filter((p) => p.path.endsWith('/observation')).length).toBe(1)
    expect(w.txs.filter((t) => t === 'submit-evidence').length).toBe(1)
    const obs = w.posts.find((p) => p.path.endsWith('/observation'))!.body as { kind: string; reading: { value: string; missionId: string } }
    expect(obs.kind).toBe('field-operator-upload') // operator-supplied number, never labelled a physical sensor
    expect(obs.reading.value).toBe('412')

    // Settled: one credit, one withdrawal.
    w.onchain.get('9')!.status = STATUS.Settled
    w.credits = 300_000n
    await fulfil(io, cfg)
    await fulfil(io, cfg)
    expect(w.txs.filter((t) => t === 'withdraw').length).toBe(1)
  })

  test('crash safety: a recorded but unconfirmed transaction is awaited, never resent', async () => {
    const { w, io } = world()
    w.missions = [lite()]
    w.onchain.set('9', onchain(STATUS.Funded))
    io.state.pending['accept:9'] = h(4242)
    w.waitResult = 'unknown' // not mined yet
    await fulfil(io, cfg)
    expect(w.txs.length).toBe(0)
    w.waitResult = 'success' // it landed while the runner was down
    w.onchain.get('9')!.status = STATUS.Assigned
    await fulfil(io, cfg)
    expect(w.txs.filter((t) => t === 'accept').length).toBe(0)
    expect(io.state.done['accept:9']).toBe(h(4242))
  })

  test('crash safety: an already-assigned mission is never accepted again', async () => {
    const { w, io } = world()
    w.missions = [lite()]
    w.onchain.set('9', onchain(STATUS.Assigned))
    w.feedValue = null
    await fulfil(io, cfg)
    expect(w.txs.length).toBe(0)
  })

  test('refuses to commit evidence that does not match its own device, wallet, nonce or hash', async () => {
    const { w, io } = world()
    w.missions = [lite()]
    w.onchain.set('9', onchain(STATUS.Assigned))
    w.feedValue = 400
    const realGet = io.api.get.bind(io.api)
    // The API returns a bundle that does not hash to the advertised evidence hash.
    io.api.get = (path: string) => (path.startsWith('/evidence/') ? Promise.resolve({ signer: device.address, provider: wallet.address, reading: { nonce: '1', missionId: '9' }, extra: 'tampered' } as never) : realGet(path))
    await expect(fulfil(io, cfg)).rejects.toThrow(/does not hash/)
    expect(w.txs.includes('submit-evidence')).toBe(false)
    // A correctly hashing bundle that belongs to somebody else's device is refused too.
    const other = { signer: '0x00000000000000000000000000000000000000BB', provider: wallet.address, reading: { nonce: '1', missionId: '9' } }
    const hash = hashCanonical(other)
    io.api.get = (path: string) => (path.startsWith('/evidence/') ? Promise.resolve(other as never) : path === '/missions/m1' ? Promise.resolve({ ...lite(), evidenceHash: hash } as never) : realGet(path))
    w.missions[0].evidenceHash = hash
    await expect(fulfil(io, cfg)).rejects.toThrow(/does not carry my device/)
    expect(w.txs.includes('submit-evidence')).toBe(false)
  })

  test('a pending withdrawal is awaited and not repeated', async () => {
    const { w, io } = world()
    w.credits = 100_000n
    io.state.pending['withdraw'] = h(777)
    w.waitResult = 'unknown'
    await fulfil(io, cfg)
    expect(w.txs.length).toBe(0)
  })

  test('only missions bound to this wallet are touched', async () => {
    const { w, io } = world()
    w.missions = [lite({ chain: { onchainId: '9', provider: '0x00000000000000000000000000000000000000CC' } })]
    w.onchain.set('9', onchain(STATUS.Funded))
    await fulfil(io, cfg)
    expect(w.txs.length).toBe(0)
  })
})
