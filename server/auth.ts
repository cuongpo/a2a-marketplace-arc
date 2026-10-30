import { randomBytes } from 'node:crypto'
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { hashRequestBody } from '../src/shared/canonical'
import { API_AUTH_STATEMENT, apiAuthDomain, apiAuthTypes, type ApiChallenge } from '../src/shared/typed'

/**
 * Wallet-signed request authentication for every mutating endpoint.
 *
 *  1. The client asks for a challenge, declaring the exact method, path and canonical body hash it will send.
 *  2. The server mints an unguessable single-use nonce with a short expiry and remembers it, bound to that
 *     method + path + body hash + chain id.
 *  3. The wallet signs the EIP-712 `ApiRequest` message (the server rebuilds it from its OWN stored copy, never
 *     from client input).
 *  4. The real request carries `Authorization: FieldQuest nonce=0x..., signature=0x...`. The server consumes the
 *     nonce, re-checks method, path, body hash, expiry and chain id, recovers the signer, and returns it.
 *
 * Roles are decided by the caller (authz.ts) from the RECOVERED signer address only. There is no bearer secret, no
 * shared key and no switch that disables this check. Challenges live in memory: a restart forgets them, which can
 * only make an old signature unusable, never replayable. Single process by design.
 */

export class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export const CHALLENGE_TTL_SEC = 120
const MAX_OUTSTANDING = 5_000

type Stored = ApiChallenge & { used: boolean }
const challenges = new Map<string, Stored>()

/** Only these POST routes can be authorised. Everything else is not signable. */
const SIGNABLE = [/^\/missions$/, /^\/missions\/[\w-]+\/(?:observation|fixture|challenge|arbiter)$/]

export function normalizePath(p: string): string {
  const noQuery = p.split('?')[0]
  const stripped = noQuery.replace(/^\/api(?=\/|$)/, '') || '/'
  return stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped
}

export const isSignablePath = (path: string) => SIGNABLE.some((r) => r.test(path))

function sweep(nowSec: number) {
  for (const [k, c] of challenges) if (nowSec > c.expiresAt + 60) challenges.delete(k)
}

export function issueChallenge(input: { method: unknown; path: unknown; bodyHash: unknown }, chainId: number, nowMs = Date.now()): ApiChallenge {
  if (input.method !== 'POST') throw new AuthError(400, 'bad_challenge_request', 'method must be POST')
  if (typeof input.path !== 'string') throw new AuthError(400, 'bad_challenge_request', 'path must be a string')
  const path = normalizePath(input.path)
  if (!isSignablePath(path)) throw new AuthError(400, 'bad_challenge_request', 'this path cannot be authorised')
  if (typeof input.bodyHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.bodyHash)) throw new AuthError(400, 'bad_challenge_request', 'bodyHash must be 32 bytes of hex')
  const nowSec = Math.floor(nowMs / 1000)
  sweep(nowSec)
  if (challenges.size >= MAX_OUTSTANDING) throw new AuthError(429, 'too_many_challenges', 'too many outstanding challenges, retry shortly')
  const c: ApiChallenge = {
    statement: API_AUTH_STATEMENT,
    method: 'POST',
    path,
    bodyHash: input.bodyHash.toLowerCase() as Hex,
    nonce: `0x${randomBytes(32).toString('hex')}`,
    issuedAt: nowSec,
    expiresAt: nowSec + CHALLENGE_TTL_SEC,
    chainId,
  }
  challenges.set(c.nonce, { ...c, used: false })
  return c
}

const HEADER = /^FieldQuest nonce=(0x[0-9a-fA-F]{64}),\s*signature=(0x[0-9a-fA-F]{130})$/

export async function authenticate(input: {
  method: string
  path: string
  body: unknown
  authorization: string | null
  chainId: number
  nowMs?: number
}): Promise<Address> {
  const m = input.authorization ? HEADER.exec(input.authorization.trim()) : null
  if (!m) throw new AuthError(401, 'unauthenticated', 'This action needs a wallet signature. Connect a wallet and sign the request.')
  const nonce = m[1].toLowerCase()
  const signature = m[2] as Hex
  const stored = challenges.get(nonce)
  if (!stored) throw new AuthError(401, 'unknown_challenge', 'Unknown or already-consumed challenge. Request a new one.')
  if (stored.used) throw new AuthError(401, 'replayed', 'This signature was already used. Each signature works once.')
  stored.used = true // consumed on first presentation, whatever happens next

  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000)
  if (nowSec > stored.expiresAt) throw new AuthError(401, 'expired', 'The signing challenge expired. Try again.')
  const path = normalizePath(input.path)
  if (input.method !== stored.method || path !== stored.path) throw new AuthError(401, 'challenge_mismatch', 'The signature was issued for a different request.')
  if (stored.chainId !== input.chainId) throw new AuthError(401, 'wrong_chain', 'The signature was issued for a different chain.')
  let bodyHash: Hex
  try {
    bodyHash = hashRequestBody(input.body)
  } catch {
    throw new AuthError(400, 'bad_body', 'The request body could not be canonicalised.')
  }
  if (bodyHash !== stored.bodyHash) throw new AuthError(401, 'body_tampered', 'The request body does not match what was signed.')

  try {
    const signer = await recoverTypedDataAddress({
      domain: apiAuthDomain(stored.chainId),
      types: apiAuthTypes,
      primaryType: 'ApiRequest',
      message: {
        statement: stored.statement,
        method: stored.method,
        path: stored.path,
        bodyHash: stored.bodyHash,
        nonce: stored.nonce,
        issuedAt: BigInt(stored.issuedAt),
        expiresAt: BigInt(stored.expiresAt),
      },
      signature,
    })
    return getAddress(signer)
  } catch {
    throw new AuthError(401, 'bad_signature', 'The signature is not valid for this challenge.')
  }
}

export function resetAuthForTests() {
  challenges.clear()
}
