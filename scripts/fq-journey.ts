// Drives real testnet missions through the RUNNING backend (bun run server). Usage:
//   bun run fq:journey accept   (provider A wins, plausible simulated reading, payout + provider withdrawal)
//   bun run fq:journey reject   (provider B wins, implausible reading, rejection + refund to the vault)
//   bun run fq:journey dispute  (ambiguous reading -> escalation -> human arbiter)
// Prints only transactions that were actually confirmed. The sensor data is a SIMULATED fixture.
import { accountFromEnv, signedPost } from './lib/signed-api'

const API = process.env.FQ_API ?? 'http://127.0.0.1:3001'
// Every write is wallet-signed by the role wallet (the same protocol the browser uses).
const operator = accountFromEnv('FQ_OPERATOR_KEY')
const providerKeys = [accountFromEnv('FQ_PROVIDER_KEY'), accountFromEnv('FQ_PROVIDER2_KEY')]
const arbiter = accountFromEnv('FQ_ARBITER_KEY')
const kind = (process.argv[2] ?? 'accept') as 'accept' | 'reject' | 'dispute'
const tileFor = { accept: process.env.FQ_TILE_ACCEPT ?? 'B2', reject: process.env.FQ_TILE_REJECT ?? 'C3', dispute: process.env.FQ_TILE_DISPUTE ?? 'D1' }

interface M {
  id: string
  stage: string
  stageNote?: string
  txs: { label: string; hash: string; status: string }[]
  audit: { agent: string; message: string }[]
  chain?: { onchainId: string; provider?: string }
  onchain?: { status: string; outcome: string } | null
  jobs: Record<string, { status: string }>
}
async function call(path: string, init?: RequestInit): Promise<M> {
  const r = await fetch(API + path, { ...init, headers: { 'content-type': 'application/json' } })
  const j = (await r.json()) as M & { error?: string }
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`)
  return j
}
const FORK = !!process.env.FQ_RPC_URL_OVERRIDE
const explorer = process.env.FQ_EXPLORER ?? 'https://explorer.testnet.arc.io'
const link = (h: string) => (FORK ? `(fork tx ${h}: local fork only, not on the public explorer)` : `${explorer}/tx/${h}`)

let m = await signedPost<M>(API, operator, '/missions', { tile: tileFor[kind], scenario: kind, budgetUsdc: '1', deadlineMinutes: 30, autoFixture: kind !== 'dispute', requireSecondSource: kind === 'dispute' || process.env.FQ_REQUIRE_PAID_REFERENCE === '1', challengeWindowSec: 30 })
console.log(`mission ${m.id} created for tile ${tileFor[kind]} (${kind})`)
let disputed = false
const t0 = Date.now()
for (;;) {
  await new Promise((r) => setTimeout(r, 3000))
  m = await call(`/missions/${m.id}`)
  if (m.stage === 'blocked' || m.stage === 'failed') throw new Error(`mission ${m.stage}: ${m.stageNote ?? ''}`)
  if (kind === 'dispute' && m.stage === 'awaiting_observation' && !m.onchain?.status?.includes('Submitted')) {
    if (!disputed) {
      const bound = providerKeys.find((k) => k.address.toLowerCase() === m.chain?.provider?.toLowerCase())
      if (!bound) throw new Error('bound provider wallet is not in this .env')
      await signedPost(API, bound, `/missions/${m.id}/fixture`, { variant: 'ambiguous' })
      disputed = true
    }
  }
  if (kind === 'dispute' && m.stage === 'challenged') {
    await signedPost(API, arbiter, `/missions/${m.id}/arbiter`, { providerWins: false })
  }
  const post = ['withdraw_provider', 'withdraw_verifier', 'reconcile'].every((k) => !m.jobs[k] || m.jobs[k].status === 'done' || m.jobs[k].status === 'failed')
  if ((m.stage === 'settled' || m.stage === 'expired') && m.jobs.reconcile?.status && post) break
  if (Date.now() - t0 > 20 * 60_000) throw new Error('timed out waiting for the mission')
  process.stdout.write(`\r${m.stage} / onchain ${m.onchain?.status ?? '-'}      `)
}
console.log(`\nfinal: ${m.stage}; outcome ${m.onchain?.outcome}`)
for (const t of m.txs) console.log(`${t.status.padEnd(8)} ${t.label}\n         ${link(t.hash)}`)
console.log(`receipt: /receipt/${m.id}`)
