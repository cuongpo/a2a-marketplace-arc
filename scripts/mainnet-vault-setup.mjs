// Configure a bounded Arc Mainnet pilot vault. Dry-run by default; --broadcast spends real USDC.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'

const env = Object.fromEntries(readFileSync('.env.mainnet', 'utf8').split(/\r?\n/).filter((s) => /^[A-Z0-9_]+=/.test(s)).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]))
const operator = privateKeyToAccount(env.FQ_OPERATOR_KEY)
const buyer = privateKeyToAccount(env.FQ_BUYER_AGENT_KEY).address
if (operator.address !== '0x150216eA4513b02376CcF8C73a6EF1B8aDD98C98') throw new Error('Unexpected mainnet operator')
const dep = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
if (dep.chainId !== 5042 || !['vault', 'escrow'].every((key) => /^0x[0-9a-fA-F]{40}$/.test(dep[key] ?? '')))
  throw new Error('Mainnet vault and escrow are not deployed')
const rpc = env.MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
const wallet = createWalletClient({ account: operator, chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
if (await client.getChainId() !== 5042) throw new Error('RPC is not Arc Mainnet')
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const vaultAbi = JSON.parse(readFileSync('contracts/out/AgentBudgetVault.sol/AgentBudgetVault.json', 'utf8')).abi
const target = parseUnits('0.80', 6)
const perMissionCap = parseUnits('0.50', 6)
const totalCap = target
const dailyCap = target
const broadcast = process.argv.includes('--broadcast')
if (process.argv.some((arg) => arg !== '--broadcast' && arg !== process.argv[0] && arg !== process.argv[1])) throw new Error('Only --broadcast is supported')
if (await client.getCode({ address: dep.vault }) === '0x' || await client.getCode({ address: dep.escrow }) === '0x') throw new Error('Vault or escrow has no code')
const trusted = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'isTrustedEscrow', args: [dep.escrow] })
if (!trusted) throw new Error('Vault does not trust the deployed escrow')

async function send(label, address, abi, functionName, args) {
  const { request } = await client.simulateContract({ account: operator, address, abi, functionName, args })
  const estimate = await client.estimateContractGas({ account: operator.address, address, abi, functionName, args })
  const gas = estimate * 120n / 100n
  const maxFeePerGas = (await client.getGasPrice()) * 2n + 1_000_000_000n
  if (maxFeePerGas > 100_000_000_000n || gas * maxFeePerGas > 50_000_000_000_000_000n)
    throw new Error(`${label} exceeds the 100 Gwei / 0.05 USDC fee guard`)
  const hash = await wallet.writeContract({ ...request, gas, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })
  console.log(`${label} tx ${hash}`)
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`${label} failed: ${hash}`)
  console.log(`${label} confirmed at block ${receipt.blockNumber}`)
}

const tokenBalance = await client.readContract({ address: dep.usdc, abi: tokenAbi, functionName: 'balanceOf', args: [operator.address] })
let available = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'availableOf', args: [operator.address] })
console.log(`Mode: ${broadcast ? 'BROADCAST' : 'DRY RUN'}; operator ${operator.address}; wallet ${formatUnits(tokenBalance, 6)} USDC; vault available ${formatUnits(available, 6)} USDC`)
if (available > target) throw new Error('Operator vault already exceeds the 0.80 USDC pilot target; inspect before continuing')
if (available < target) {
  const delta = target - available
  if (tokenBalance < delta + parseUnits('0.20', 6)) throw new Error('Operator wallet needs deposit plus 0.20 USDC gas reserve')
  const allowance = await client.readContract({ address: dep.usdc, abi: tokenAbi, functionName: 'allowance', args: [operator.address, dep.vault] })
  console.log(`Deposit needed: ${formatUnits(delta, 6)} USDC; current allowance ${formatUnits(allowance, 6)} USDC`)
  if (broadcast) {
    if (allowance < delta) await send('approve vault', dep.usdc, tokenAbi, 'approve', [dep.vault, delta])
    await send('deposit vault', dep.vault, vaultAbi, 'deposit', [delta])
    available = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'availableOf', args: [operator.address] })
    if (available !== target) throw new Error('Vault available amount differs from 0.80 USDC target')
  }
}
const policy = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'policyOf', args: [operator.address] })
const policyReady = policy.executor?.toLowerCase() === buyer.toLowerCase() && policy.perMissionCap === perMissionCap && policy.totalCap === totalCap && policy.dailyCap === dailyCap && policy.expiry > BigInt(Math.floor(Date.now() / 1000) + 24 * 3600) && !policy.paused
console.log(`Policy ready: ${policyReady}; intended buyer ${buyer}, caps 0.50 / 0.80 / 0.80 USDC, expiry 72 hours`)
if (broadcast && !policyReady) {
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 72 * 3600)
  await send('set policy', dep.vault, vaultAbi, 'setPolicy', [buyer, perMissionCap, totalCap, dailyCap, expiry])
}
const allowed = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'escrowAllowed', args: [operator.address, dep.escrow] })
console.log(`Escrow allowlisted: ${Boolean(allowed)}`)
if (broadcast && !allowed) await send('allowlist escrow', dep.vault, vaultAbi, 'setEscrowAllowed', [dep.escrow, true])
if (broadcast) {
  const finalPolicy = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'policyOf', args: [operator.address] })
  const finalAllowed = await client.readContract({ address: dep.vault, abi: vaultAbi, functionName: 'escrowAllowed', args: [operator.address, dep.escrow] })
  if (finalPolicy.executor?.toLowerCase() !== buyer.toLowerCase() || finalPolicy.perMissionCap !== perMissionCap || finalPolicy.totalCap !== totalCap || finalPolicy.dailyCap !== dailyCap || !finalAllowed)
    throw new Error('Final onchain policy or escrow allowlist differs from pilot plan')
}
console.log(broadcast ? 'Bounded mainnet vault setup complete.' : 'Dry run complete. No transaction was created.')
