import type { Address } from 'viem'
import { account, hasRole } from './env'
import { escrowRead, vaultRead } from './chain'
import { AuthError } from './auth'
import type { MissionRecord } from '../src/shared/types'

/**
 * Role checks. They take only the RECOVERED signer address plus on-chain / persisted state, never anything the
 * caller merely claims. A missing server key can only make an action unavailable (409/503), never skip a check.
 */

export type Role = 'operator' | 'provider' | 'arbiter'

export interface PolicyView {
  executor: Address
  expiry: bigint
  paused: boolean
}

export interface AuthzDeps {
  readPolicy(operator: Address): Promise<PolicyView>
  arbiterAddress(): Promise<Address>
  buyerAgent(): Address | null
  nowSec(): number
}

export const liveDeps: AuthzDeps = {
  readPolicy: (op) => vaultRead<PolicyView>('policyOf', [op]),
  arbiterAddress: () => escrowRead<Address>('arbiter'),
  buyerAgent: () => (hasRole('buyer') ? account('buyer').address : null),
  nowSec: () => Math.floor(Date.now() / 1000),
}

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const wrongRole = (required: Role, expected: string | null, message: string) =>
  new AuthError(403, 'wrong_role', message, { required, expected })

/** Creating a mission: the signer must have authorised THIS buyer agent in the vault (live policy, not paused, not expired). */
export async function requireAuthorisedOperator(signer: Address, deps: AuthzDeps): Promise<void> {
  const buyer = deps.buyerAgent()
  if (!buyer) throw new AuthError(503, 'buyer_agent_unavailable', 'The buyer agent is not configured on this server.')
  let policy: PolicyView
  try {
    policy = await deps.readPolicy(signer)
  } catch {
    throw new AuthError(503, 'chain_unavailable', 'Could not read your vault policy from the chain. Try again shortly.')
  }
  if (!same(policy.executor, buyer))
    throw wrongRole('operator', null, `Wallet ${signer} has not authorised the buyer agent ${buyer} in the vault. Set up your vault budget first (Vault panel).`)
  if (policy.paused) throw wrongRole('operator', null, 'Your vault policy is paused. Unpause it before opening missions.')
  if (BigInt(deps.nowSec()) > policy.expiry) throw wrongRole('operator', null, 'Your vault policy has expired. Renew it before opening missions.')
}

export function requireMissionOperator(signer: Address, m: MissionRecord): void {
  if (!same(signer, m.operator)) throw wrongRole('operator', m.operator, `Only the mission's operator ${m.operator} can do this. You are connected as ${signer}.`)
}

export function requireBoundProvider(signer: Address, m: MissionRecord): void {
  if (!m.chain) throw new AuthError(409, 'not_funded', 'This mission is not funded onchain yet, so no provider is bound.')
  if (!same(signer, m.chain.provider))
    throw wrongRole('provider', m.chain.provider, `Only the provider bound to this mission (${m.chain.provider}) can supply evidence. You are connected as ${signer}.`)
}

export async function requireArbiter(signer: Address, deps: AuthzDeps): Promise<void> {
  let arbiter: Address
  try {
    arbiter = await deps.arbiterAddress()
  } catch {
    throw new AuthError(503, 'chain_unavailable', 'Could not read the arbiter address from the chain.')
  }
  if (!same(signer, arbiter)) throw wrongRole('arbiter', arbiter, `Only the arbiter ${arbiter} can rule on a dispute. You are connected as ${signer}.`)
}
