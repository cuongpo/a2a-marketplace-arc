// Builds a reviewable deployment plan from compiled artifacts. No signing or broadcasting.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPublicClient, getContractAddress, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'

const env = Object.fromEntries(readFileSync('.env.mainnet', 'utf8').split(/\r?\n/).filter((s) => /^[A-Z0-9_]+=/.test(s)).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]))
const deployer = privateKeyToAccount(env.MAINNET_DEPLOYER_KEY)
const arbiter = privateKeyToAccount(env.FQ_ARBITER_KEY).address
const dep = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
if (dep.chainId !== 5042 || dep.network !== 'mainnet') throw new Error('wrong deployment manifest')
if (['registry', 'escrow', 'vault', 'adapter'].some((name) => dep[name])) throw new Error('deployment manifest already has own contract addresses; review the existing deployment before planning a new one')
const client = createPublicClient({ chain: arc, transport: http(env.MAINNET_RPC_URL ?? 'https://rpc.mainnet.arc.io') })
if (await client.getChainId() !== 5042) throw new Error('RPC is not Arc Mainnet')
const nonce = await client.getTransactionCount({ address: deployer.address, blockTag: 'pending' })
const names = ['EvidenceRegistry', 'MissionEscrow', 'AgentBudgetVault', 'Erc8004Adapter']
const address = Object.fromEntries(names.map((name, i) => [name, getContractAddress({ from: deployer.address, nonce: BigInt(nonce + i) })]))
const args = {
  EvidenceRegistry: [],
  MissionEscrow: [dep.usdc, address.EvidenceRegistry, arbiter],
  AgentBudgetVault: [dep.usdc, [address.MissionEscrow]],
  Erc8004Adapter: [dep.identityRegistry, dep.reputationRegistry, address.MissionEscrow],
}
console.log(`Arc Mainnet deployer ${deployer.address}, pending nonce ${nonce}. Predicted addresses change if this wallet sends another transaction first.`)
for (let i = 0; i < names.length; i++) {
  const name = names[i]
  const artifact = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, 'utf8'))
  const bytecode = artifact.bytecode?.object
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode ?? '')) throw new Error(`${name} compiled bytecode is missing; run forge build`)
  console.log(`${i + 1}. ${name} nonce=${nonce + i} predicted=${address[name]} bytecodeSHA256=${createHash('sha256').update(Buffer.from(bytecode.slice(2), 'hex')).digest('hex')}`)
  console.log(`   constructor=${JSON.stringify(args[name])}`)
}
console.log('Plan only. No transaction was created. Audit the exact compiled artifacts before deployment.')
