// Prepare a static Vercel bundle with a no-key read-only API and a durable public snapshot.
// The function serves public GET responses captured here and refreshes Arc balances directly.
// An optional no-key read-only tunnel can supply new mission data during an active pilot.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { keccak256, toBytes } from 'viem'

const origin = process.env.FQ_PUBLIC_API_ORIGIN ?? null
if (origin && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin))
  throw new Error('FQ_PUBLIC_API_ORIGIN must be a no-key trycloudflare read-only API origin')
const localApi = process.env.FQ_PUBLIC_LOCAL_API ?? 'http://127.0.0.1:3003'
const paths = ['health', 'overview', 'tiles', 'feed', 'agents', 'missions', 'missions/1717cca0', 'missions/2f3e3d08', 'receipt/1', 'receipt/2']
const snapshot = {}
for (const path of paths) {
  const response = await fetch(`${localApi}/api/${path}`)
  if (!response.ok) throw new Error(`Public read-only API ${path} returned ${response.status}`)
  snapshot[path] = await response.json()
}
if (snapshot.overview?.network !== 'mainnet' || snapshot.overview?.readOnly !== true || snapshot.overview?.chainId !== 5042)
  throw new Error('Refusing to deploy a viewer without a keyless Arc Mainnet read-only API')
if (!Array.isArray(snapshot.missions) || snapshot.missions.length < 2 || snapshot.missions.some((m) => m.stage !== 'settled'))
  throw new Error('Both mainnet pilot missions must be settled before capturing the durable viewer')
mkdirSync('dist/api', { recursive: true })
const selector = (signature) => keccak256(toBytes(signature)).slice(0, 10)
const chain = {
  vault: snapshot.overview.contracts.vault,
  escrow: snapshot.overview.contracts.escrow,
  usdc: snapshot.overview.usdc,
  operator: snapshot.overview.vault.operator,
  selectors: {
    available: selector('availableOf(address)'),
    committed: selector('committedOf(address)'),
    netSpent: selector('netSpentOf(address)'),
    liabilities: selector('totalLiabilities()'),
    balance: selector('balanceOf(address)'),
  },
}
const functionSource = readFileSync('scripts/public-viewer-template.txt', 'utf8')
  .replace('__SNAPSHOT__', JSON.stringify(snapshot))
  .replace('__UPSTREAM__', JSON.stringify(origin))
  .replace('__CHAIN__', JSON.stringify(chain))
writeFileSync('dist/api/pilot.mjs', functionSource)
writeFileSync('dist/vercel.json', JSON.stringify({ version: 2, rewrites: [
  { source: '/api/:path*', destination: '/api/pilot?path=:path*' },
  { source: '/receipt/:path*', destination: '/index.html' },
] }, null, 2) + '\n')
console.log(`Prepared public viewer: ${paths.length} completed-pilot GET snapshots, direct Arc RPC reads${origin ? `, optional no-key upstream ${origin}` : ''}, no signing keys`)
