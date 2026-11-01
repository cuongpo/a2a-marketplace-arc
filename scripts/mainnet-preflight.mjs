// Read-only Arc Mainnet preflight. It never signs or broadcasts and never prints private keys.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync, statSync } from 'node:fs'
import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'

const ENV_PATH = '.env.mainnet'
const DEPLOYMENT_PATH = 'src/deployments/arc-mainnet.json'
const USDC = '0x3600000000000000000000000000000000000000'
const IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
const ROLE_KEYS = [
  ['Deployer', 'MAINNET_DEPLOYER_KEY'], ['Operator', 'FQ_OPERATOR_KEY'],
  ['Buyer agent', 'FQ_BUYER_AGENT_KEY'], ['Verifier', 'FQ_VERIFIER_KEY'],
  ['Arbiter', 'FQ_ARBITER_KEY'], ['Provider A', 'PROVIDER_AGENT_KEY'],
  ['Device A', 'DEVICE_KEY'], ['Provider B', 'PROVIDER2_AGENT_KEY'],
  ['Device B', 'DEVICE2_KEY'],
]
function privateEnv(path) {
  const stat = statSync(path)
  if ((stat.mode & 0o077) !== 0) throw new Error(`${path} must be readable only by its owner (chmod 600)`)
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter((s) => /^[A-Z0-9_]+=/.test(s)).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]))
}
const env = privateEnv(ENV_PATH)
if (env.FQ_NETWORK !== 'mainnet' || env.FQ_ENABLE_FIXTURE !== '0') throw new Error('mainnet env must select mainnet and disable fixtures')
if (env.FQ_ALLOW_MAINNET_SERVER_KEYS) throw new Error('mainnet server signing is already unlocked in the wallet vault; remove that setting until after audit')
const wallets = ROLE_KEYS.map(([label, key]) => {
  const secret = env[key]
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret ?? '')) throw new Error(`missing or invalid ${key}`)
  return { label, address: privateKeyToAccount(secret).address }
})
if (new Set(wallets.map((w) => w.address.toLowerCase())).size !== wallets.length) throw new Error('two roles share one wallet')
const server = privateEnv('.env.mainnet.server')
if (server.FQ_NETWORK !== 'mainnet' || server.FQ_ENABLE_FIXTURE !== '0' || server.FQ_BUYER_AGENT_KEY !== env.FQ_BUYER_AGENT_KEY ||
  server.FQ_VERIFIER_KEY !== env.FQ_VERIFIER_KEY || !['', 'i-understand'].includes(server.FQ_ALLOW_MAINNET_SERVER_KEYS ?? '') ||
  ['FQ_OPERATOR_KEY', 'FQ_ARBITER_KEY', 'PROVIDER_AGENT_KEY', 'DEVICE_KEY'].some((key) => key in server))
  throw new Error('isolated mainnet server env is mismatched, unlocked or contains a human/provider key')
for (const [suffix, providerKey, deviceKey] of [['a', 'PROVIDER_AGENT_KEY', 'DEVICE_KEY'], ['b', 'PROVIDER2_AGENT_KEY', 'DEVICE2_KEY']]) {
  const provider = privateEnv(`.env.mainnet.provider-${suffix}`)
  if (provider.RUNNER_NETWORK !== 'mainnet' || !['', 'audited-and-funded'].includes(provider.RUNNER_MAINNET_ACK ?? '') || provider.SIMULATED === '1' ||
    provider.PROVIDER_AGENT_KEY !== env[providerKey] || provider.DEVICE_KEY !== env[deviceKey] ||
    ['FQ_OPERATOR_KEY', 'FQ_ARBITER_KEY', 'FQ_BUYER_AGENT_KEY', 'FQ_VERIFIER_KEY'].some((key) => key in provider))
    throw new Error(`isolated provider ${suffix} env is mismatched, unlocked or contains a backend/human key`)
}

const dep = JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8'))
if (dep.chainId !== 5042 || dep.network !== 'mainnet' || dep.usdc?.toLowerCase() !== USDC.toLowerCase() ||
  dep.identityRegistry?.toLowerCase() !== IDENTITY.toLowerCase() || dep.reputationRegistry?.toLowerCase() !== REPUTATION.toLowerCase())
  throw new Error('deployment manifest differs from the expected Arc Mainnet facts')

const rpc = env.MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ chain: arc, transport: http(rpc, { timeout: 15_000, retryCount: 2 }) })
const [chainId, gasPrice, block] = await Promise.all([client.getChainId(), client.getGasPrice(), client.getBlockNumber()])
if (chainId !== 5042) throw new Error(`RPC returned chain ${chainId}, expected Arc Mainnet 5042`)
for (const [label, address] of [['USDC', USDC], ['ERC-8004 Identity', IDENTITY], ['ERC-8004 Reputation', REPUTATION]]) {
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`${label} has no contract code at ${address}`)
}
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'])
const decimals = await client.readContract({ address: USDC, abi: erc20, functionName: 'decimals' })
if (decimals !== 6) throw new Error(`USDC ERC-20 has ${decimals} decimals, expected 6`)
console.log(`Arc Mainnet RPC verified: chain ${chainId}, block ${block}, gas ${formatUnits(gasPrice, 9)} Gwei`)
console.log(`USDC and ERC-8004 registries have code. Native gas is USDC; ERC-20 accounting is 6 decimals.`)
for (const w of wallets) {
  const balance = await client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [w.address] })
  console.log(`${w.label.padEnd(12)} ${w.address}  ${formatUnits(balance, 6)} USDC`)
}
const own = ['registry', 'escrow', 'vault', 'adapter']
const deployed = own.filter((name) => isAddress(dep[name] ?? ''))
for (const name of deployed) {
  const address = getAddress(dep[name])
  const code = await client.getCode({ address })
  if (!code || code === '0x') throw new Error(`${name} manifest address ${address} has no onchain code`)
}
console.log(`Own contracts with code: ${deployed.length}/4. ${deployed.length < 4 ? 'Deployment is pending.' : 'Inspect constructor immutables and verified source before use.'}`)
console.log(`Pilot switches: server ${server.FQ_ALLOW_MAINNET_SERVER_KEYS ? 'enabled' : 'locked'}; providers must use independent real-data feeds.`)
const baselineGas = 7_448_098n // Sum of four confirmed Arc Testnet deployment receipts; not a mainnet gas quote.
console.log(`Historical deployment gas x current price: ~${formatUnits(baselineGas * gasPrice, 18)} USDC; re-estimate immediately before deployment.`)
console.log('Read-only preflight complete. No signature or transaction was created.')
