// Fund the isolated Arc Mainnet pilot roles. Dry-run by default; --broadcast spends real USDC.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'

const env = Object.fromEntries(readFileSync('.env.mainnet', 'utf8').split(/\r?\n/).filter((s) => /^[A-Z0-9_]+=/.test(s)).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]))
const deployer = privateKeyToAccount(env.MAINNET_DEPLOYER_KEY)
if (deployer.address !== '0x34a296FA80703Eaecfd03a07882Dcc780c0A4b53') throw new Error('Unexpected mainnet deployer')
const roles = [
  ['Operator', 'FQ_OPERATOR_KEY', '2.00'],
  ['Buyer', 'FQ_BUYER_AGENT_KEY', '0.25'],
  ['Verifier', 'FQ_VERIFIER_KEY', '0.25'],
  ['Provider A', 'PROVIDER_AGENT_KEY', '0.25'],
  ['Provider B', 'PROVIDER2_AGENT_KEY', '0.25'],
  ['Arbiter', 'FQ_ARBITER_KEY', '0.10'],
]
const broadcast = process.argv.includes('--broadcast')
if (process.argv.some((arg) => arg !== '--broadcast' && arg !== process.argv[0] && arg !== process.argv[1])) throw new Error('Only --broadcast is supported')
const dep = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
if (dep.chainId !== 5042 || !['registry', 'escrow', 'vault', 'adapter'].every((key) => /^0x[0-9a-fA-F]{40}$/.test(dep[key] ?? '')))
  throw new Error('Arc Mainnet pilot contracts are not all deployed')
const rpc = env.MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
const wallet = createWalletClient({ account: deployer, chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
if (await client.getChainId() !== 5042) throw new Error('RPC is not Arc Mainnet')
const abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'])
const tokenBalance = (address) => client.readContract({ address: dep.usdc, abi, functionName: 'balanceOf', args: [address] })
const total = roles.reduce((sum, [, , amount]) => sum + parseUnits(amount, 6), 0n)
if (total !== 3_100_000n) throw new Error('Funding plan total differs from 3.10 USDC')
console.log(`Mode: ${broadcast ? 'BROADCAST' : 'DRY RUN'}; deployer ${deployer.address}; planned role funding 3.10 USDC`)
for (const [label, key, amount] of roles) {
  const recipient = privateKeyToAccount(env[key]).address
  const target = parseUnits(amount, 6)
  const current = await tokenBalance(recipient)
  console.log(`${label}: ${recipient}, current ${formatUnits(current, 6)}, target ${amount} USDC`)
  if (current >= target || !broadcast) continue
  const delta = target - current
  const available = await tokenBalance(deployer.address)
  if (available < delta + 1_000_000n) throw new Error('Deployer needs a 1 USDC reserve after each transfer')
  const args = [recipient, delta]
  const { request } = await client.simulateContract({ account: deployer, address: dep.usdc, abi, functionName: 'transfer', args })
  const gasEstimate = await client.estimateContractGas({ account: deployer.address, address: dep.usdc, abi, functionName: 'transfer', args })
  const gas = gasEstimate * 120n / 100n
  const maxFeePerGas = (await client.getGasPrice()) * 2n + 1_000_000_000n
  if (maxFeePerGas > 100_000_000_000n || gas * maxFeePerGas > 50_000_000_000_000_000n)
    throw new Error(`${label} transfer exceeds the 100 Gwei / 0.05 USDC fee guard`)
  const hash = await wallet.writeContract({ ...request, gas, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })
  console.log(`${label} funding tx ${hash}`)
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success' || await tokenBalance(recipient) < target) throw new Error(`${label} funding failed or balance did not reach target: ${hash}`)
  console.log(`${label} confirmed at block ${receipt.blockNumber}`)
}
console.log(broadcast ? 'Role funding complete.' : 'Dry run complete. No transaction was created.')
