import { readFileSync, existsSync } from 'node:fs'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { NetworkMode } from '../src/shared/types'

/**
 * Server-only configuration. Bun loads .env automatically; keys never leave this process,
 * are never logged and are never sent to the browser.
 */

export type Role = 'operator' | 'buyer' | 'providerA' | 'sensorA' | 'providerB' | 'sensorB' | 'verifier' | 'arbiter'

const ROLE_ENV: Record<Role, string> = {
  operator: 'FQ_OPERATOR_KEY',
  buyer: 'FQ_BUYER_AGENT_KEY',
  providerA: 'FQ_PROVIDER_KEY',
  sensorA: 'FQ_SENSOR_KEY',
  providerB: 'FQ_PROVIDER2_KEY',
  sensorB: 'FQ_SENSOR2_KEY',
  verifier: 'FQ_VERIFIER_KEY',
  arbiter: 'FQ_ARBITER_KEY',
}

export interface Deployment {
  network: NetworkMode
  chainId: number
  rpcUrl: string
  explorer: string
  usdc: Address
  registry: Address
  escrow: Address
  vault: Address
  adapter?: Address
  identityRegistry?: Address
  reputationRegistry?: Address
  deployedAt?: string
  deployTxs?: Record<string, Hex>
}

export const NETWORK: NetworkMode = process.env.FQ_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'

const IS_MAINNET = NETWORK === 'mainnet'

/** Hard guard: the Studio-hosted server refuses to use server-held demo keys against mainnet. */
export function assertTestnetOnlyKeys(): void {
  if (IS_MAINNET && process.env.FQ_ALLOW_MAINNET_SERVER_KEYS !== 'i-understand') {
    throw new Error(
      'Refusing to run server-held role keys against mainnet. Mainnet is operated from your own wallets outside Arc Studio (see docs/MAINNET_RUNBOOK.md).',
    )
  }
}

export function loadDeployment(): Deployment | null {
  const file = IS_MAINNET ? 'src/deployments/arc-mainnet.json' : 'src/deployments/arc-testnet.json'
  if (!existsSync(file)) return null
  const d = JSON.parse(readFileSync(file, 'utf8')) as Deployment
  if (!d.escrow || !d.vault || !d.registry) return null
  return d
}

const accounts = new Map<Role, PrivateKeyAccount>()
export function account(role: Role): PrivateKeyAccount {
  const cached = accounts.get(role)
  if (cached) return cached
  const raw = process.env[ROLE_ENV[role]]
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`Missing ${ROLE_ENV[role]} in .env (run: bun run fq:keygen)`)
  }
  const a = privateKeyToAccount(raw as Hex)
  accounts.set(role, a)
  return a
}

export function hasRole(role: Role): boolean {
  const raw = process.env[ROLE_ENV[role]]
  return !!raw && /^0x[0-9a-fA-F]{64}$/.test(raw)
}

export function roleAddresses(): Partial<Record<Role, Address>> {
  const out: Partial<Record<Role, Address>> = {}
  for (const r of Object.keys(ROLE_ENV) as Role[]) if (hasRole(r)) out[r] = account(r).address
  return out
}

export const config = {
  port: Number(process.env.FQ_SERVER_PORT ?? 3001),
  dataDir: process.env.FQ_DATA_DIR ?? 'data',
  fixtureEnabled: !IS_MAINNET && process.env.FQ_ENABLE_FIXTURE !== '0',
  verifierFeeUsdc: 50_000n, // 0.05 USDC (6 decimals)
  llmKey: process.env.FQ_LLM_API_KEY ?? '',
}

/** RPC URL: the sandbox RPC proxy when provisioned for the chain, else the public URL from onchain-facts/deployment. */
export function rpcUrlFor(chainKey: 'Arc_Testnet' | 'Arc', fallback: string): string {
  // Local fork rehearsal only (see docs/TESTING.md). Transactions on a fork do NOT exist on the public chain.
  if (process.env.FQ_RPC_URL_OVERRIDE) return process.env.FQ_RPC_URL_OVERRIDE
  const chains = (process.env.RPC_PROXY_CHAINS ?? '').split(',')
  if (process.env.RPC_PROXY_BASE_URL && process.env.RPC_PROXY_TOKEN && chains.includes(chainKey)) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${chainKey}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  }
  return fallback
}
