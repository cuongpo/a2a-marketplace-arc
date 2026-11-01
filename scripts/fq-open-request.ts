// Opens ONE custom (open-auction) request as the demo operator via the wallet-signed API, then follows it to the end.
// Spends from the operator's vault budget (the winning quote + 0.05 USDC verifier fee), so run it deliberately.
// Usage: bun run scripts/fq-open-request.ts <tile A1..F4> [budgetUsdc=1] [quoteWindowSec=90]
import { accountFromEnv, signedPost } from './lib/signed-api'

const API = process.env.FQ_API ?? 'http://127.0.0.1:3001'
const explorer = process.env.FQ_EXPLORER ?? 'https://explorer.testnet.arc.io'
const [, , tile, budget = '1', window = '90'] = process.argv
if (!tile) throw new Error('usage: fq-open-request.ts <tile> [budgetUsdc] [quoteWindowSec]')
interface M {
  id: string
  stage: string
  stageNote?: string
  chain?: { onchainId: string; provider: string }
  onchain?: { status: string; outcome: string } | null
  invites?: { entries: { name: string; wallet: string; score: number }[] }
  quotes: { providerName: string; priceUsdc: string }[]
  decision?: { rationale: string }
  feedback?: { status: string; txHash?: string; entries: { role: string; agentId: string; outcome: string; value?: string }[] }
  txs: { label: string; hash: string; status: string }[]
  jobs: Record<string, { status: string }>
}
const operator = accountFromEnv('FQ_OPERATOR_KEY')
let m = await signedPost<M>(API, operator, '/missions', { tile, scenario: 'custom', budgetUsdc: budget, deadlineMinutes: 30, quoteWindowSec: Number(window), challengeWindowSec: 30 })
console.log(`request ${m.id} opened for ${tile}`)
let last = ''
for (const t0 = Date.now(); Date.now() - t0 < 14 * 60_000; ) {
  await new Promise((r) => setTimeout(r, 4000))
  m = (await (await fetch(`${API}/missions/${m.id}`)).json()) as M
  const line = `${m.stage}/${m.onchain?.status ?? '-'} invites=${m.invites?.entries.length ?? '-'} bids=${m.quotes.length}`
  if (line !== last) console.log(line)
  last = line
  if (m.stage === 'blocked' || m.stage === 'failed') throw new Error(`mission ${m.stage}: ${m.stageNote ?? ''}`)
  const done = ['reconcile', 'feedback'].every((k) => ['done', 'failed'].includes(m.jobs[k]?.status ?? '')) && ['settled', 'expired'].includes(m.stage)
  if (done) break
}
console.log('invited:', (m.invites?.entries ?? []).map((e) => `${e.name} (${e.score})`).join(', ') || 'none')
console.log('bids:', m.quotes.map((q) => `${q.providerName} ${q.priceUsdc}`).join(', '))
console.log('decision:', m.decision?.rationale.slice(0, 600))
console.log(`final: onchain #${m.chain?.onchainId} ${m.onchain?.status}/${m.onchain?.outcome}; winner ${m.chain?.provider}`)
console.log('feedback:', JSON.stringify(m.feedback))
for (const t of m.txs) console.log(`${t.status.padEnd(8)} ${t.label}\n         ${explorer}/tx/${t.hash}`)
