// One-time TESTNET setup for the paid x402 reference demo. Prints public addresses, balances and public
// transaction hashes only; no key is ever printed.
//   bun run scripts/fq-reference-setup.ts keys <TILE>   create separate seller + buyer keys and the SIMULATED feed
//   bun run scripts/fq-reference-setup.ts fund          operator -> buyer (<= 0.02 USDC total), buyer -> Gateway (<= 0.01 USDC total)
//   bun run scripts/fq-reference-setup.ts status        public balances only
// The seller key goes ONLY into .env.seller (ignored by git, read only by the seller process).
// The backend .env gets the buyer key plus the seller's PUBLIC address and the service URL.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GatewayClient } from '@circle-fin/x402-batching/client'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { account } from '../server/env'
import { CHAIN_ID, erc20Abi, explorerBase, send, usdcAddress, usdcBalance } from '../server/chain'
import { referenceGaugeMm } from '../server/fixture'
import { formatUsdc } from '../src/onchain-money'
import { referenceConfig } from '../server/second-source'

const MAX_FUND_ATOMIC = 20_000n // 0.02 USDC total into the buyer wallet
const MAX_DEPOSIT_ATOMIC = 10_000n // 0.01 USDC total into Gateway
const DEPOSIT = '0.005' // below the cap; leaves the rest of the 0.02 for gas
const SELLER_ENV = resolve('.env.seller')
const FEED = resolve('data/reference-feed.json')
const FUND_MARKER = resolve('data/reference-fund-used.json')
const cmd = process.argv[2]
const link = (h: string) => `${explorerBase}/tx/${h}`

if (CHAIN_ID !== 5042002) throw new Error('testnet only')

function hasLine(file: string, name: string) {
  return existsSync(file) && new RegExp(`^${name}=.+`, 'm').test(readFileSync(file, 'utf8'))
}

function keys() {
  const tile = process.argv[3] ?? 'A1'
  if (!/^[A-F][1-4]$/.test(tile)) throw new Error('tile must look like A1')
  if (hasLine('.env', 'FQ_REFERENCE_BUYER_KEY') || existsSync(SELLER_ENV)) throw new Error('reference keys already exist; refusing to overwrite')
  const buyerKey = generatePrivateKey()
  const buyer = privateKeyToAccount(buyerKey)
  // Never store the seller key anywhere but the seller-only file.
  const sellerKey = generatePrivateKey()
  const sellerAcct = privateKeyToAccount(sellerKey)
  mkdirSync('data', { recursive: true })
  writeFileSync(FEED, JSON.stringify({ [tile]: { valueMm: referenceGaugeMm(tile), observedAt: 'now', sourceId: 'demo-reference-seller', provenance: 'simulated-fixture' } }, null, 2))
  writeFileSync(
    SELLER_ENV,
    ['FQ_NETWORK=testnet', `FQ_REFERENCE_SIGNER_KEY=${sellerKey}`, `FQ_REFERENCE_SELLER_ADDRESS=${sellerAcct.address}`, `FQ_REFERENCE_FEED_FILE=${FEED}`, 'FQ_REFERENCE_SELLER_PORT=3002', ''].join('\n'),
    { mode: 0o600 },
  )
  const env = readFileSync('.env', 'utf8')
  appendFileSync(
    '.env',
    `${env.endsWith('\n') ? '' : '\n'}FQ_REFERENCE_SERVICE_URL=http://127.0.0.1:3002\nFQ_REFERENCE_BUYER_KEY=${buyerKey}\nFQ_REFERENCE_SIGNER_ADDRESS=${sellerAcct.address}\nFQ_REFERENCE_SELLER_ADDRESS=${sellerAcct.address}\n`,
  )
  console.log('seller signer/payee (public):', sellerAcct.address)
  console.log('buyer Gateway wallet (public):', buyer.address)
  console.log(`SIMULATED feed written for ${tile}: ${referenceGaugeMm(tile)} mm (provenance simulated-fixture, source demo-reference-seller)`)
}

function buyerClient() {
  const cfg = referenceConfig()
  if (!cfg) throw new Error('backend .env is missing the FQ_REFERENCE_* buyer settings (or network is not testnet)')
  return { cfg, buyer: privateKeyToAccount(cfg.key), client: new GatewayClient({ chain: 'arcTestnet', privateKey: cfg.key }) }
}

async function show(label: string) {
  const { buyer, client } = buyerClient()
  const b = await client.getBalances()
  console.log(`${label}: buyer ${buyer.address} wallet ${formatUsdc(await usdcBalance(buyer.address))} USDC | Gateway total ${b.gateway.formattedTotal} available ${b.gateway.formattedAvailable} USDC`)
  return b
}

async function fund() {
  const { buyer, client } = buyerClient()
  const op = await usdcBalance(account('operator').address)
  console.log('operator wallet USDC:', formatUsdc(op))
  const b0 = await usdcBalance(buyer.address)
  const before = await client.getBalances()
  console.log('before:', 'buyer wallet', formatUsdc(b0), 'USDC; Gateway available', before.gateway.formattedAvailable)
  // One-use marker is written before any transaction. A crash or uncertain RPC
  // result must be reviewed manually rather than causing a second transfer.
  // Existing funded wallets are marked used too: current balance alone cannot
  // establish how much was previously deposited and spent.
  if (existsSync(FUND_MARKER)) { console.log('automatic funding already used for this demo wallet; no transfer or deposit'); return }
  mkdirSync('data', { recursive: true })
  if (before.gateway.total + before.gateway.withdrawing > 0n || b0 > 0n) {
    writeFileSync(FUND_MARKER, JSON.stringify({ buyer: buyer.address, reason: 'existing funds; automatic setup disabled' }), { flag: 'wx', mode: 0o600 })
    console.log('buyer already funded or deposited; automatic setup disabled to preserve the cumulative cap')
    return
  }
  if (op < MAX_FUND_ATOMIC + 50_000n) throw new Error('operator wallet balance too low; stopping payment work')
  writeFileSync(FUND_MARKER, JSON.stringify({ buyer: buyer.address, reason: 'automatic setup attempted' }), { flag: 'wx', mode: 0o600 })
  const { hash } = await send('operator', { address: usdcAddress, abi: erc20Abi, functionName: 'transfer', args: [buyer.address, MAX_FUND_ATOMIC] })
  console.log('funded buyer with 0.02 USDC:', link(hash))
  const after = await client.getBalances()
  if (after.gateway.total === 0n) {
    const depositAtomic = 5_000n
    if (after.gateway.total + depositAtomic > MAX_DEPOSIT_ATOMIC) throw new Error('deposit would exceed the 0.01 USDC cap')
    const res = await client.deposit(DEPOSIT)
    if (res.approvalTxHash) console.log('approval tx:', link(res.approvalTxHash))
    console.log(`Gateway deposit ${res.formattedAmount} USDC:`, link(res.depositTxHash))
  } else console.log('Gateway balance already present; not depositing again')
  for (let i = 0; i < 60; i++) {
    const b = await client.getBalances()
    if (b.gateway.available >= 1_000n) break
    await new Promise((r) => setTimeout(r, 3_000))
  }
  const fin = await show('after')
  if (fin.gateway.available < 1_000n) throw new Error('Gateway available balance is still below 0.001 USDC; do not purchase yet')
}

if (cmd === 'keys') keys()
else if (cmd === 'fund') await fund()
else if (cmd === 'status') await show('status')
else console.log('usage: keys <TILE> | fund | status')
process.exit(0)
