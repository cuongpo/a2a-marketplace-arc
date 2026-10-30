// Wallet-signed POST helper for scripts. Uses the SAME protocol as the browser (see server/auth.ts):
// ask for a challenge bound to method + path + canonical body hash, sign it with the role wallet, send it.
// Keys come from the environment and are never printed.
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { hashRequestBody } from '../../src/shared/canonical'
import { apiAuthDomain, apiAuthTypes, type ApiChallenge } from '../../src/shared/typed'

export function accountFromEnv(name: string) {
  const raw = process.env[name]
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Missing ${name} in .env (bun run fq:keygen)`)
  return privateKeyToAccount(raw as Hex)
}

export async function signedPost<T>(api: string, signer: ReturnType<typeof accountFromEnv>, path: string, body: unknown = {}): Promise<T> {
  const bodyHash = hashRequestBody(body)
  const ch = await fetch(`${api}/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', path, bodyHash }) })
  const c = (await ch.json()) as ApiChallenge & { error?: string }
  if (!ch.ok) throw new Error(`challenge for ${path}: ${c.error ?? ch.status}`)
  if (c.method !== 'POST' || c.path !== path || c.bodyHash !== bodyHash) throw new Error('server returned a challenge for a different request')
  const signature = await signer.signTypedData({
    domain: apiAuthDomain(c.chainId),
    types: apiAuthTypes,
    primaryType: 'ApiRequest',
    message: { statement: c.statement, method: c.method, path: c.path, bodyHash: c.bodyHash, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt) },
  })
  const res = await fetch(api + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `FieldQuest nonce=${c.nonce}, signature=${signature}` },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`)
  return json
}
