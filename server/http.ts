import { isAddress, type Address } from 'viem'
import { hasRole, account, NETWORK } from './env'
import { CHAIN_ID, errMsg } from './chain'
import { getEvidence, missions, recentFeed } from './store'
import { HttpError, advance, arbiterResolve, createMission, fixtureObservation, operatorChallenge, prepareExternalEvidence, submitObservation, submitQuote } from './pipeline'
import { jsonSafe, overview, publicMission, receipt, tiles, vaultFor } from './api'
import { AuthError, authenticate, issueChallenge } from './auth'
import { liveDeps, requireArbiter, requireAuthorisedOperator, requireBoundProvider, requireMissionOperator, same, type AuthzDeps } from './authz'
import type { MissionRecord, SignedReadingInput } from '../src/shared/types'

const MAX_BODY = 64 * 1024

/** Swappable in tests. Production uses the live chain-backed deps. */
export const deps: { authz: AuthzDeps; kick: (m: MissionRecord) => void; prepareExternal: (m: MissionRecord, o: SignedReadingInput) => Promise<void> } = {
  authz: liveDeps,
  kick: (m) => void advance(m).catch(() => undefined),
  prepareExternal: prepareExternalEvidence,
}

class Limiter {
  private hits: number[] = []
  constructor(private max: number) {}
  hit(): boolean {
    const now = Date.now()
    while (this.hits.length && now - this.hits[0] > 60_000) this.hits.shift()
    if (this.hits.length >= this.max) return true
    this.hits.push(now)
    return false
  }
}
const challengeLimiter = new Limiter(90)
const mutationLimiter = new Limiter(60)

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(jsonSafe(data)), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.length > MAX_BODY) throw new HttpError(413, 'body too large')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

function must(id: string) {
  const m = missions.get(id)
  if (!m) throw new HttpError(404, 'mission not found')
  return m
}

async function mutate(req: Request, path: string): Promise<Response> {
  if (mutationLimiter.hit()) throw new HttpError(429, 'rate limited')
  const body = await readBody(req)
  // Authenticate FIRST: an unauthenticated caller learns nothing about missions or roles.
  const signer = await authenticate({
    method: req.method,
    path,
    body,
    authorization: req.headers.get('authorization'),
    chainId: CHAIN_ID,
  })

  if (path === '/missions') {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (b.operator !== undefined && !(typeof b.operator === 'string' && isAddress(b.operator) && same(b.operator, signer)))
      throw new AuthError(403, 'wrong_role', 'A mission can only be opened for the wallet that signs the request.', { required: 'operator', expected: signer })
    await requireAuthorisedOperator(signer, deps.authz)
    const m = createMission({ ...b, operator: signer })
    deps.kick(m)
    return json(await publicMission(m), 201)
  }

  let r: RegExpMatchArray | null
  if ((r = path.match(/^\/missions\/([\w-]+)\/quotes$/))) {
    const m = must(r[1])
    await submitQuote(m, body, signer)
    return json(await publicMission(m), 201)
  }
  if ((r = path.match(/^\/missions\/([\w-]+)\/observation$/))) {
    const m = must(r[1])
    requireBoundProvider(signer, m)
    await submitObservation(m, body, deps.prepareExternal)
    return json(await publicMission(m))
  }
  if ((r = path.match(/^\/missions\/([\w-]+)\/fixture$/))) {
    const m = must(r[1])
    requireBoundProvider(signer, m)
    const v = (['valid', 'implausible', 'ambiguous'] as const).find((x) => x === (body as { variant?: string }).variant)
    await fixtureObservation(m, v)
    return json(await publicMission(m))
  }
  if ((r = path.match(/^\/missions\/([\w-]+)\/challenge$/))) {
    const m = must(r[1])
    requireMissionOperator(signer, m)
    await operatorChallenge(m)
    return json(await publicMission(m))
  }
  if ((r = path.match(/^\/missions\/([\w-]+)\/arbiter$/))) {
    const m = must(r[1])
    await requireArbiter(signer, deps.authz)
    if (!hasRole('arbiter') || !same(account('arbiter').address, signer))
      throw new AuthError(409, 'server_does_not_hold_key', 'This server does not hold the arbiter key. Call MissionEscrow.resolve from the arbiter wallet directly.')
    const pw = (body as { providerWins?: unknown }).providerWins
    if (typeof pw !== 'boolean') throw new HttpError(400, 'providerWins must be boolean')
    await arbiterResolve(m, pw)
    return json(await publicMission(m))
  }
  return json({ error: 'not found' }, 404)
}

export async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/'
  const method = req.method

  if (method === 'GET') {
    if (path === '/health') return json({ ok: true, network: NETWORK, auth: 'wallet-signed' })
    if (path === '/overview') return json(await overview())
    if (path === '/tiles') return json(await tiles())
    if (path === '/feed') return json(recentFeed(100))
    if (path === '/missions') return json(await Promise.all(missions.all().slice(0, 40).map(publicMission)))
    let r: RegExpMatchArray | null
    if ((r = path.match(/^\/missions\/([\w-]+)$/))) return json(await publicMission(must(r[1])))
    if ((r = path.match(/^\/vault\/(0x[0-9a-fA-F]{40})$/))) return json(await vaultFor(r[1] as Address, deps.authz))
    if ((r = path.match(/^\/receipt\/([\w-]+)$/))) {
      const rc = await receipt(r[1])
      return rc ? json(rc) : json({ error: 'receipt not found' }, 404)
    }
    if ((r = path.match(/^\/evidence\/(0x[0-9a-fA-F]{64})$/))) {
      const b = getEvidence(r[1])
      return b ? json(b) : json({ error: 'evidence not found' }, 404)
    }
    return json({ error: 'not found' }, 404)
  }

  if (method === 'POST') {
    if (path === '/auth/challenge') {
      if (challengeLimiter.hit()) throw new HttpError(429, 'rate limited')
      const b = (await readBody(req)) as Record<string, unknown>
      return json(issueChallenge({ method: b.method, path: b.path, bodyHash: b.bodyHash }, CHAIN_ID))
    }
    return mutate(req, path)
  }
  return json({ error: 'method not allowed' }, 405)
}

/** Full handler with uniform error mapping. */
export async function handle(req: Request): Promise<Response> {
  try {
    return await route(req)
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message, code: e.code, ...e.extra }, e.status)
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    console.error('[api]', errMsg(e))
    return json({ error: 'internal error' }, 500)
  }
}
