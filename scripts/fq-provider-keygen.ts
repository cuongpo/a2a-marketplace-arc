// Creates a TESTNET-ONLY external provider env file (own wallet key + separate device key). Keys are written to an
// ignored file with mode 600 and are never printed; only public addresses are. Usage:
//   bun run scripts/fq-provider-keygen.ts <name> [feed|simulated|none]
// Then fund the printed wallet address with a little test USDC for gas and run:
//   bun --no-env-file --env-file=.env.provider-<name> run runner/provider-agent.ts
import { existsSync, writeFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const name = (process.argv[2] ?? '').toLowerCase()
const mode = process.argv[3] ?? 'none'
if (!/^[a-z0-9-]{1,20}$/.test(name)) throw new Error('usage: fq-provider-keygen.ts <name: a-z0-9-> [feed|simulated|none]')
const file = `.env.provider-${name}`
if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite keys`)
const wallet = generatePrivateKey()
const device = generatePrivateKey()
const lines = [
  '# External provider runner env. TESTNET ONLY. Never commit. See docs/EXTERNAL_PROVIDER.md.',
  `PROVIDER_AGENT_KEY=${wallet}`,
  `DEVICE_KEY=${device}`,
  'A2A_API=http://127.0.0.1:3001',
  `PROVIDER_NAME=External Agent ${name}`,
  'CAPABILITY=field-operator',
  'MIN_PRICE_USDC=0.10',
  'MAX_PRICE_USDC=0.60',
  'QUOTE_PRICE_USDC=0.30',
  'ETA_SEC=600',
  'MAX_ETA_SEC=1800',
  'BID_ON_UNINVITED=0',
  'POLL_SEC=5',
  ...(mode === 'feed' ? [`FEED_FILE=./feed-${name}.json`] : mode === 'simulated' ? ['SIMULATED=1'] : []),
]
writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
if (mode === 'feed') writeFileSync(`feed-${name}.json`, '{}\n')
console.log(`wrote ${file} (mode 600)`)
console.log('provider wallet (public):', privateKeyToAccount(wallet).address)
console.log('device signer   (public):', privateKeyToAccount(device).address)
