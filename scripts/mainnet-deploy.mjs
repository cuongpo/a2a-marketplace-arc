// Arc Mainnet pilot deployment. Dry-run by default; --broadcast sends real transactions.
// The deployer key is read only from the gitignored local vault and never printed.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, encodeDeployData, formatUnits, getContractAddress, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'

const manifestPath = 'src/deployments/arc-mainnet.json'
const env = Object.fromEntries(readFileSync('.env.mainnet', 'utf8').split(/\r?\n/).filter((s) => /^[A-Z0-9_]+=/.test(s)).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]))
const deployer = privateKeyToAccount(env.MAINNET_DEPLOYER_KEY)
const arbiter = privateKeyToAccount(env.FQ_ARBITER_KEY).address
const expectedDeployer = '0x34a296FA80703Eaecfd03a07882Dcc780c0A4b53'
if (deployer.address !== expectedDeployer) throw new Error('The local deployer key does not match the funded pilot wallet')
const dep = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (dep.chainId !== 5042 || dep.network !== 'mainnet' || dep.usdc?.toLowerCase() !== '0x3600000000000000000000000000000000000000')
  throw new Error('Mainnet manifest does not match Arc chain 5042 and official USDC')
const rpc = env.MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const publicClient = createPublicClient({ chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
const walletClient = createWalletClient({ account: deployer, chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 3 }) })
const names = ['EvidenceRegistry', 'MissionEscrow', 'AgentBudgetVault', 'Erc8004Adapter']
const fields = ['registry', 'escrow', 'vault', 'adapter']
const expected = names.map((_, nonce) => getContractAddress({ from: deployer.address, nonce: BigInt(nonce) }))
const args = [[], [dep.usdc, expected[0], arbiter], [dep.usdc, [expected[1]]], [dep.identityRegistry, dep.reputationRegistry, expected[1]]]
const getters = [[], [['usdc', dep.usdc], ['registry', expected[0]], ['arbiter', arbiter]], [['usdc', dep.usdc], ['isTrustedEscrow', true, expected[1]]], [['identity', dep.identityRegistry], ['reputation', dep.reputationRegistry], ['escrow', expected[1]]]]
const broadcast = process.argv.includes('--broadcast')
if (process.argv.some((arg) => arg !== '--broadcast' && arg !== process.argv[0] && arg !== process.argv[1])) throw new Error('Only --broadcast is supported')
if (await publicClient.getChainId() !== 5042) throw new Error('RPC is not Arc Mainnet')
const codeAt = async (address) => (await publicClient.getCode({ address })) ?? '0x'
for (const address of [dep.usdc, dep.identityRegistry, dep.reputationRegistry])
  if (await codeAt(address) === '0x') throw new Error(`Required Arc contract has no code: ${address}`)
const token = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'])
if (await publicClient.readContract({ address: dep.usdc, abi: token, functionName: 'decimals' }) !== 6) throw new Error('USDC decimals are not 6')

function saveManifest() {
  const temp = `${manifestPath}.tmp`
  writeFileSync(temp, JSON.stringify(dep, null, 2) + '\n')
  renameSync(temp, manifestPath)
}

async function verify(i) {
  const address = expected[i]
  if (await codeAt(address) === '0x') throw new Error(`${names[i]} has no code at predicted address ${address}`)
  for (const [name, value, arg] of getters[i]) {
    const abi = parseAbi([`function ${name}(${arg ? 'address' : ''}) view returns (${typeof value === 'boolean' ? 'bool' : 'address'})`])
    const actual = await publicClient.readContract({ address, abi, functionName: name, args: arg ? [arg] : [] })
    if (typeof value === 'boolean' ? actual !== value : actual.toLowerCase() !== value.toLowerCase())
      throw new Error(`${names[i]}.${name} did not match the reviewed constructor argument`)
  }
}

const startBalance = await publicClient.getBalance({ address: deployer.address })
const ercBalance = await publicClient.readContract({ address: dep.usdc, abi: token, functionName: 'balanceOf', args: [deployer.address] })
console.log(`Arc Mainnet deployer ${deployer.address}: ${formatUnits(startBalance, 18)} native USDC, ${formatUnits(ercBalance, 6)} ERC-20 USDC`)
console.log(`Mode: ${broadcast ? 'BROADCAST real USDC gas' : 'DRY RUN, no signing'}`)
for (let i = 0; i < names.length; i++) {
  const artifact = JSON.parse(readFileSync(`contracts/out/${names[i]}.sol/${names[i]}.json`, 'utf8'))
  const bytecode = artifact.bytecode?.object
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode ?? '')) throw new Error(`${names[i]} artifact is missing; run forge build`)
  const address = expected[i]
  if (dep[fields[i]]) {
    if (dep[fields[i]].toLowerCase() !== address.toLowerCase()) throw new Error(`${names[i]} manifest address differs from expected nonce plan`)
    await verify(i)
    console.log(`${names[i]} already verified at ${address}`)
    continue
  }
  const pending = dep.deployTxs?.[fields[i]]
  if (pending) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: pending, timeout: 120_000 })
    if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) throw new Error(`${names[i]} pending transaction did not deploy as planned`)
    await verify(i)
    dep[fields[i]] = address
    saveManifest()
    console.log(`${names[i]} recovered and verified at ${address}`)
    continue
  }
  const nonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: 'pending' })
  if (broadcast && nonce !== i) throw new Error(`${names[i]} expected deployer nonce ${i}, got ${nonce}; inspect pending transactions before continuing`)
  const data = encodeDeployData({ abi: artifact.abi, bytecode, args: args[i] })
  // Vault constructor checks escrow code, so its gas estimate is available only after escrow deploys.
  const gasEstimate = i === 2 && !dep.escrow ? null : await publicClient.estimateGas({ account: deployer.address, data })
  const gasPrice = await publicClient.getGasPrice()
  const maxFeePerGas = gasPrice * 2n + 1_000_000_000n
  const gasLimit = gasEstimate === null ? null : gasEstimate * 120n / 100n
  console.log(`${i + 1}. ${names[i]} -> ${address}; estimate ${gasEstimate ?? 'after escrow'} gas, current ${formatUnits(gasPrice, 9)} Gwei`)
  if (!broadcast) continue
  if (gasLimit === null) throw new Error('Vault gas estimate unavailable; do not broadcast before escrow deployment')
  if (maxFeePerGas > 100_000_000_000n || gasLimit * maxFeePerGas > 500_000_000_000_000_000n)
    throw new Error(`${names[i]} exceeds the 100 Gwei / 0.5 USDC transaction fee guard`)
  const balance = await publicClient.getBalance({ address: deployer.address })
  if (balance < gasLimit * maxFeePerGas + 500_000_000_000_000_000n) throw new Error('Deployer balance is below gas plus 0.5 USDC reserve')
  const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode, args: args[i], gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n })
  console.log(`${names[i]} broadcast tx ${hash}`)
  dep.deployTxs ??= {}
  dep.deployTxs[fields[i]] = hash
  saveManifest()
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) throw new Error(`${names[i]} receipt failed or address differed from plan: ${hash}`)
  await verify(i)
  dep[fields[i]] = address
  dep.deployedAt ??= new Date().toISOString()
  saveManifest()
  console.log(`${names[i]} confirmed block ${receipt.blockNumber}, gas used ${receipt.gasUsed}, verified ${address}`)
}
console.log(broadcast ? 'Deployment complete. Inspect mainnet receipts and verify source on explorer.' : 'Dry run complete. No signature or transaction was created.')
