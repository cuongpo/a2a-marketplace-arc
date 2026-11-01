// Opens one bounded Arc Mainnet pilot auction from the operator's signed wallet.
// Run only with --no-env-file --env-file=.env.mainnet; the key never reaches the backend.
import { accountFromEnv, signedPost } from './lib/signed-api'

const api = 'http://127.0.0.1:3001/api'
const tile = process.argv.slice(2).find((arg) => /^[A-D][1-4]$/.test(arg)) ?? 'B3'
const operator = accountFromEnv('FQ_OPERATOR_KEY')
if (operator.address !== '0x150216eA4513b02376CcF8C73a6EF1B8aDD98C98') throw new Error('Unexpected Arc Mainnet operator')
const overview = await (await fetch(`${api}/overview`)).json() as { network: string; chainId: number; contracts?: { escrow?: string } }
if (overview.network !== 'mainnet' || overview.chainId !== 5042 || !overview.contracts?.escrow) throw new Error('Backend is not the deployed Arc Mainnet pilot')
const body = { tile, scenario: 'custom', budgetUsdc: '0.45', quoteWindowSec: 90, deadlineMinutes: 60, challengeWindowSec: 60, requireSecondSource: false }
if (!process.argv.includes('--broadcast')) {
  console.log(`Dry run: one ${tile} auction, 0.45 USDC max budget, 90s bidding, 60m deadline; the winning provider must supply a source-labelled observation.`)
  console.log('No API write or transaction was created. Pass --broadcast to open the mission.')
} else {
  const result = await signedPost<{ id: string; stage: string; spec: { tile: string } }>(api, operator, '/missions', body)
  console.log(`Opened Arc Mainnet mission ${result.id}, tile ${result.spec.tile}, stage ${result.stage}`)
}
