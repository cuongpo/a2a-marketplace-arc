// Generates TESTNET-ONLY role keys into .env (never printed). Existing keys are never overwritten.
// Prints only the public addresses. Do not reuse these keys on mainnet.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const ROLES = [
  'FQ_OPERATOR_KEY', // human operator stand-in (owns the vault budget) — demo key held by the server
  'FQ_BUYER_AGENT_KEY', // buyer agent executor (spends only inside vault policy)
  'FQ_PROVIDER_KEY', // provider A wallet
  'FQ_SENSOR_KEY', // SIMULATED sensor fixture device key for provider A
  'FQ_PROVIDER2_KEY', // provider B wallet (separate wallet for the rejected journey)
  'FQ_SENSOR2_KEY', // SIMULATED sensor fixture device key for provider B
  'FQ_VERIFIER_KEY', // verifier agent wallet
  'FQ_ARBITER_KEY', // human dispute arbiter (demo key held by the server)
] as const

const envPath = '.env'
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const lines: string[] = []
for (const role of ROLES) {
  const m = new RegExp(`^${role}=(0x[0-9a-fA-F]{64})\\s*$`, 'm').exec(existing)
  let key = m?.[1] as `0x${string}` | undefined
  if (!key) {
    key = generatePrivateKey()
    lines.push(`${role}=${key}`)
  }
  console.log(role.padEnd(20), privateKeyToAccount(key).address, m ? '(existing)' : '(new)')
}
if (lines.length) appendFileSync(envPath, (existing.endsWith('\n') || !existing ? '' : '\n') + lines.join('\n') + '\n')
