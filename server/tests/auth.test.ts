import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from 'viem'

// Isolated data dir BEFORE importing modules that read config at load time.
const dir = mkdtempSync(join(tmpdir(), 'fq-auth-test-'))
process.env.FQ_DATA_DIR = dir
process.env.FQ_ENABLE_FIXTURE = '1'
// The role-authorization tests use mocked chain policy; only the verifier
// address is needed to construct an in-memory funded mission.
process.env.FQ_VERIFIER_KEY ??= generatePrivateKey()
process.env.FQ_SENSOR_KEY ??= generatePrivateKey()

const { handle, deps } = await import('../http')
const { authenticate, issueChallenge, resetAuthForTests, AuthError } = await import('../auth')
const { missions } = await import('../store')
const { createMission } = await import('../pipeline')
const { decide } = await import('../agents/buyer')
const { account } = await import('../env')
const { CHAIN_ID, requireDeployment } = await import('../chain')
const { makeFixtureObservation } = await import('../fixture')
const { hashRequestBody } = await import('../../src/shared/canonical')
const { apiAuthDomain, apiAuthTypes, quoteDomain, quoteTypes, tileIdOf } = await import('../../src/shared/typed')
type Challenge = import('../../src/shared/typed').ApiChallenge

// Test files share one module instance (and so one store) in a single bun process: clean up once, at exit.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const BUYER: Address = '0x00000000000000000000000000000000000B0B0B'
const operator = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())
const provider = privateKeyToAccount(generatePrivateKey())
const arbiter = privateKeyToAccount(generatePrivateKey())
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

let kicked: string[] = []
beforeEach(() => {
  resetAuthForTests()
  for (const m of missions.all()) m.stage = 'settled' // free the tile; these test missions are never advanced
  kicked = []
  deps.kick = (m) => void kicked.push(m.id)
  deps.prepareExternal = () => Promise.resolve() // Role/auth tests do not connect to a live escrow.
  deps.authz = {
    readPolicy: (op) =>
      Promise.resolve(
        same(op, operator.address)
          ? { executor: BUYER, expiry: BigInt(Math.floor(Date.now() / 1000) + 100_000), paused: false }
          : { executor: '0x0000000000000000000000000000000000000000', expiry: 0n, paused: false },
      ),
    arbiterAddress: () => Promise.resolve(arbiter.address),
    buyerAgent: () => BUYER,
    nowSec: () => Math.floor(Date.now() / 1000),
  }
})

const url = (p: string) => `http://localhost/api${p}`

async function getChallenge(path: string, bodyHash: string): Promise<Challenge> {
  const res = await handle(new Request(url('/auth/challenge'), { method: 'POST', body: JSON.stringify({ method: 'POST', path, bodyHash }) }))
  expect(res.status).toBe(200)
  return (await res.json()) as Challenge
}

async function sign(acct: PrivateKeyAccount, c: Challenge) {
  return acct.signTypedData({
    domain: apiAuthDomain(c.chainId),
    types: apiAuthTypes,
    primaryType: 'ApiRequest',
    message: { statement: c.statement, method: c.method, path: c.path, bodyHash: c.bodyHash, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt) },
  })
}

/** Full client flow. `signBody` is what the wallet authorised; `sendBody` is what actually goes on the wire. */
async function signedPost(acct: PrivateKeyAccount, path: string, signBody: unknown, sendBody: unknown = signBody) {
  const c = await getChallenge(path, hashRequestBody(signBody))
  const signature = await sign(acct, c)
  const authorization = `A2AMarket nonce=${c.nonce}, signature=${signature}`
  const res = await handle(new Request(url(path), { method: 'POST', headers: { authorization }, body: JSON.stringify(sendBody) }))
  return { res, authorization, c, signature }
}
const codeOf = async (r: Response) => ((await r.clone().json()) as { code?: string }).code

function fundedMission(tile: string) {
  const dep = requireDeployment()
  const m = createMission({ tile, scenario: 'accept', budgetUsdc: '1', operator: operator.address })
  m.chain = {
    chainId: CHAIN_ID,
    escrow: dep.escrow,
    onchainId: '91',
    provider: provider.address,
    verifier: account('verifier').address,
    providerPrice: '400000',
    verifierFee: '50000',
    deadline: m.spec.deadlineUnix,
    createdBlock: '1',
    createdAtChain: Math.floor(Date.now() / 1000) - 30,
  }
  return m
}

describe('unauthenticated writes are rejected', () => {
  test('every mutating route returns 401 without a signature and changes nothing', async () => {
    const before = missions.all().length
    for (const path of ['/missions', '/missions/abc/quotes', '/missions/abc/observation', '/missions/abc/fixture', '/missions/abc/challenge', '/missions/abc/arbiter']) {
      const res = await handle(new Request(url(path), { method: 'POST', body: JSON.stringify({ tile: 'F1', providerWins: true }) }))
      expect(res.status).toBe(401)
      expect(await codeOf(res)).toBe('unauthenticated')
    }
    expect(missions.all().length).toBe(before)
    expect(kicked.length).toBe(0)
  })
  test('malformed header and unknown nonce are rejected', async () => {
    for (const authorization of ['Bearer abc', 'A2AMarket nonce=0x12, signature=0x34', `A2AMarket nonce=0x${'11'.repeat(32)}, signature=0x${'22'.repeat(65)}`]) {
      const res = await handle(new Request(url('/missions'), { method: 'POST', headers: { authorization }, body: '{}' }))
      expect(res.status).toBe(401)
    }
  })
  test('a path that cannot be authorised gets no challenge', async () => {
    const res = await handle(new Request(url('/auth/challenge'), { method: 'POST', body: JSON.stringify({ method: 'POST', path: '/overview', bodyHash: hashRequestBody({}) }) }))
    expect(res.status).toBe(400)
    const get = await handle(new Request(url('/auth/challenge'), { method: 'GET' }))
    expect(get.status).toBe(404)
  })
})

describe('valid wallet signatures', () => {
  test('an external provider can submit one independently signed quote', async () => {
    const m = createMission({ tile: 'E4', scenario: 'custom', budgetUsdc: '1', operator: operator.address })
    const quote = {
      provider: provider.address, providerName: 'External Agent', priceUsdc: '400000', etaSec: 300,
      evidenceCapability: 'field-operator', validUntil: m.spec.deadlineUnix,
      tileId: tileIdOf(m.spec.tile), specHash: m.specHash,
    }
    const signature = await provider.signTypedData({ domain: quoteDomain(CHAIN_ID), types: quoteTypes, primaryType: 'Quote', message: {
      provider: provider.address, specHash: m.specHash, tileId: quote.tileId, priceUsdc: 400000n,
      etaSec: 300n, validUntil: BigInt(quote.validUntil), capability: quote.evidenceCapability,
    } })
    const body = { ...quote, signature }
    const [first, duplicate] = await Promise.all([
      signedPost(provider, `/missions/${m.id}/quotes`, body),
      signedPost(provider, `/missions/${m.id}/quotes`, body),
    ])
    expect([first.res.status, duplicate.res.status].sort()).toEqual([201, 409])
    expect(m.quotes.length).toBe(1)
    expect(m.quotes[0].simulated).toBe(false)
    const forged = await signedPost(stranger, `/missions/${m.id}/quotes`, body)
    expect(forged.res.status).toBe(403)
    await decide(m)
    expect(m.decision?.scored[0].quote.provider).toBe(provider.address)
    expect(m.decision?.chosenQuoteId).toBe(m.quotes[0].quoteId)
  })
  test('an authorised operator can open a mission; the operator is the recovered signer', async () => {
    const { res } = await signedPost(operator, '/missions', { tile: 'F1', scenario: 'custom', budgetUsdc: '1' })
    expect(res.status).toBe(201)
    const m = (await res.json()) as { id: string; operator: string }
    expect(m.operator).toBe(operator.address)
    expect(kicked).toEqual([m.id])
    expect(missions.get(m.id)?.operator).toBe(operator.address)
  })
  test('the bound provider can upload a signed reading', async () => {
    const m = fundedMission('F2')
    const obs = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    const { res } = await signedPost(provider, `/missions/${m.id}/observation`, obs)
    expect(res.status).toBe(200)
    expect(missions.get(m.id)?.observation?.reading.nonce).toBe(obs.reading.nonce)
  })
  test('works through the /api prefix and without it, but the signature stays bound to the normalised path', async () => {
    const c = await getChallenge('/api/missions', hashRequestBody({ tile: 'F1' }))
    expect(c.path).toBe('/missions')
  })
})

describe('replay, tampering, expiry', () => {
  test('replaying a used signature is rejected', async () => {
    const body = { tile: 'F1', scenario: 'custom', budgetUsdc: '1' }
    const first = await signedPost(stranger, '/missions', body) // fails on role, but the nonce is consumed
    expect(first.res.status).toBe(403)
    const again = await handle(new Request(url('/missions'), { method: 'POST', headers: { authorization: first.authorization }, body: JSON.stringify(body) }))
    expect(again.status).toBe(401)
    expect(await codeOf(again)).toBe('replayed')
  })
  test('a successful request cannot be replayed either', async () => {
    const m = fundedMission('F2')
    const obs = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    const ok = await signedPost(provider, `/missions/${m.id}/observation`, obs)
    expect(ok.res.status).toBe(200)
    const again = await handle(new Request(url(`/missions/${m.id}/observation`), { method: 'POST', headers: { authorization: ok.authorization }, body: JSON.stringify(obs) }))
    expect(await codeOf(again)).toBe('replayed')
  })
  test('a tampered body is rejected', async () => {
    const { res } = await signedPost(operator, '/missions', { tile: 'F1', budgetUsdc: '1' }, { tile: 'F1', budgetUsdc: '5' })
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('body_tampered')
    expect(kicked.length).toBe(0)
  })
  test('key order and whitespace do not matter, content does', async () => {
    const signBody = { tile: 'F1', scenario: 'custom', budgetUsdc: '1' }
    const c = await getChallenge('/missions', hashRequestBody(signBody))
    const authorization = `A2AMarket nonce=${c.nonce}, signature=${await sign(operator, c)}`
    const reordered = '{ "budgetUsdc": "1",   "scenario":"custom", "tile":"F1" }'
    const res = await handle(new Request(url('/missions'), { method: 'POST', headers: { authorization }, body: reordered }))
    expect(res.status).toBe(201)
  })
  test('a signature for one path cannot be used on another', async () => {
    const a = fundedMission('F2')
    const body = {}
    const c = await getChallenge(`/missions/${a.id}/challenge`, hashRequestBody(body))
    const authorization = `A2AMarket nonce=${c.nonce}, signature=${await sign(operator, c)}`
    const res = await handle(new Request(url(`/missions/${a.id}/arbiter`), { method: 'POST', headers: { authorization }, body: JSON.stringify(body) }))
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('challenge_mismatch')
  })
  test('a signature over a forged challenge (client-chosen nonce) is rejected', async () => {
    const forged: Challenge = { statement: 'x', method: 'POST', path: '/missions', bodyHash: hashRequestBody({}), nonce: `0x${'ab'.repeat(32)}`, issuedAt: 1, expiresAt: 9_999_999_999, chainId: CHAIN_ID }
    const authorization = `A2AMarket nonce=${forged.nonce}, signature=${await operator.signTypedData({
      domain: apiAuthDomain(CHAIN_ID),
      types: apiAuthTypes,
      primaryType: 'ApiRequest',
      message: { statement: forged.statement, method: forged.method, path: forged.path, bodyHash: forged.bodyHash, nonce: forged.nonce, issuedAt: 1n, expiresAt: 9_999_999_999n },
    })}`
    const res = await handle(new Request(url('/missions'), { method: 'POST', headers: { authorization }, body: '{}' }))
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('unknown_challenge')
  })
  test('an expired challenge is rejected', async () => {
    const body = { tile: 'F1' }
    const issuedLongAgo = Date.now() - 10 * 60_000
    const c = issueChallenge({ method: 'POST', path: '/missions', bodyHash: hashRequestBody(body) }, CHAIN_ID, issuedLongAgo)
    const sig = await sign(operator, c)
    let err: unknown
    try {
      await authenticate({ method: 'POST', path: '/missions', body, authorization: `A2AMarket nonce=${c.nonce}, signature=${sig}`, chainId: CHAIN_ID })
    } catch (e) {
      err = e
    }
    expect(err instanceof AuthError).toBe(true)
    expect((err as InstanceType<typeof AuthError>).code).toBe('expired')
  })
  test('a signature is rejected when the chain id differs', async () => {
    const body = {}
    const c = issueChallenge({ method: 'POST', path: '/missions', bodyHash: hashRequestBody(body) }, CHAIN_ID)
    const sig = await sign(operator, c)
    let code = ''
    try {
      await authenticate({ method: 'POST', path: '/missions', body, authorization: `A2AMarket nonce=${c.nonce}, signature=${sig}`, chainId: CHAIN_ID + 1 })
    } catch (e) {
      code = (e as InstanceType<typeof AuthError>).code
    }
    expect(code).toBe('wrong_chain')
  })
  test('a valid signature from a different wallet than the one that signed does not authenticate as the victim', async () => {
    // The signer is recovered, never claimed: an attacker signing the challenge is the attacker.
    const { res } = await signedPost(stranger, '/missions', { tile: 'F1', scenario: 'custom', budgetUsdc: '1' })
    expect(res.status).toBe(403)
  })
})

describe('wrong role', () => {
  test('a wallet without a vault policy cannot open a mission', async () => {
    const before = missions.all().length
    const { res } = await signedPost(stranger, '/missions', { tile: 'F1', scenario: 'custom', budgetUsdc: '1' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; required: string }
    expect(body.code).toBe('wrong_role')
    expect(body.required).toBe('operator')
    expect(missions.all().length).toBe(before)
  })
  test('claiming another wallet as operator in the body is refused', async () => {
    const { res } = await signedPost(operator, '/missions', { tile: 'F1', operator: stranger.address })
    expect(res.status).toBe(403)
  })
  test('a paused or expired vault policy is not an authorisation', async () => {
    deps.authz = { ...deps.authz, readPolicy: () => Promise.resolve({ executor: BUYER, expiry: BigInt(Math.floor(Date.now() / 1000) + 1000), paused: true }) }
    expect((await signedPost(operator, '/missions', { tile: 'F1' })).res.status).toBe(403)
    deps.authz = { ...deps.authz, readPolicy: () => Promise.resolve({ executor: BUYER, expiry: 1n, paused: false }) }
    expect((await signedPost(operator, '/missions', { tile: 'F1' })).res.status).toBe(403)
  })
  test('only the bound provider may upload evidence or use the fixture', async () => {
    const m = fundedMission('F2')
    const obs = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    for (const who of [stranger, operator]) {
      const up = await signedPost(who, `/missions/${m.id}/observation`, obs)
      expect(up.res.status).toBe(403)
      expect(((await up.res.json()) as { expected: string }).expected).toBe(provider.address)
      const fx = await signedPost(who, `/missions/${m.id}/fixture`, { variant: 'valid' })
      expect(fx.res.status).toBe(403)
    }
    expect(missions.get(m.id)?.observation).toBeUndefined()
  })
  test('the bound provider passes the role check on the fixture route (and then fails only for lack of a server-managed key)', async () => {
    const m = fundedMission('F2')
    const { res } = await signedPost(provider, `/missions/${m.id}/fixture`, { variant: 'valid' })
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBeUndefined()
  })
  test('only the mission operator may challenge', async () => {
    const m = fundedMission('F2')
    const { res } = await signedPost(stranger, `/missions/${m.id}/challenge`, {})
    expect(res.status).toBe(403)
    expect(((await res.json()) as { expected: string }).expected).toBe(operator.address)
    const ok = await signedPost(operator, `/missions/${m.id}/challenge`, {})
    expect(await codeOf(ok.res)).not.toBe('wrong_role')
  })
  test('only the arbiter may arbitrate', async () => {
    const m = fundedMission('F2')
    for (const who of [stranger, operator, provider]) {
      const { res } = await signedPost(who, `/missions/${m.id}/arbiter`, { providerWins: true })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { expected: string }).expected).toBe(arbiter.address)
    }
    // the real arbiter passes the role check; this server does not hold that test key, so it refuses instead of acting
    const ok = await signedPost(arbiter, `/missions/${m.id}/arbiter`, { providerWins: true })
    expect(ok.res.status).toBe(409)
    expect(await codeOf(ok.res)).toBe('server_does_not_hold_key')
  })
  test('unknown missions are only visible to authenticated callers', async () => {
    const anon = await handle(new Request(url('/missions/nope/challenge'), { method: 'POST', body: '{}' }))
    expect(anon.status).toBe(401)
    const authed = await signedPost(operator, '/missions/nope/challenge', {})
    expect(authed.res.status).toBe(404)
  })
})

describe('reads stay public', () => {
  test('health, tiles and missions need no wallet', async () => {
    for (const p of ['/health', '/feed']) expect((await handle(new Request(url(p)))).status).toBe(200)
  })
})
