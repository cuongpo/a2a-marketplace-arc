// Read-only, reproducible Arc Mainnet proof for the two hackathon pilot missions.
// No wallet keys, API server, or local state are required.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment
import { readFileSync } from 'node:fs'
import { createPublicClient, http, parseAbi } from 'viem'
import { arc } from 'viem/chains'

const d = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
const client = createPublicClient({ chain: arc, transport: http('https://rpc.mainnet.arc.io', { timeout: 20_000, retryCount: 3 }) })
if (await client.getChainId() !== 5042 || d.chainId !== 5042) throw new Error('Wrong Arc chain')
const escrowAbi = JSON.parse(readFileSync('contracts/out/MissionEscrow.sol/MissionEscrow.json', 'utf8')).abi
const vaultAbi = parseAbi(['function availableOf(address) view returns (uint256)', 'function committedOf(address) view returns (uint256)', 'function netSpentOf(address) view returns (uint256)'])
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
const operator = '0x150216eA4513b02376CcF8C73a6EF1B8aDD98C98'
const evidence = [
  { id: 1n, outcome: 1, evidenceHash: '0xb3e3b7adc0f2ca48ba53ec4dde70ca0ce058f164ea0c580b3321f3b396b0bd53', txs: [
    '0xe41183603f924075cd28b01826bebceab6c782ddcbd056bda00b15d9647e1776',
    '0x9bf4c683e68029fe2bc896cc3f61f3e384077482031517ed311e8614148eea11',
    '0x39062980a7d50815463a77601ecf8197459434a67e2d7260967cdb14c97824ae',
    '0x76bf4352ea802306127043901b97bbbe50e7fa358a1d414f4f856925b14c95a2',
    '0x429bd06f03a0064d3d5b374d816623233c3068545d3b5b2ae7848cbaa9e262ca',
    '0x3d0adc78dfc7c40ccdadcf031cae88c3bb9bd6c4a92b7999340db9d217875293',
    '0x8ba69ed4b847a6eeee7dfcc8f6c568ffd73ecda9edb764cd8e5d84834805d7b5',
  ] },
  { id: 2n, outcome: 2, evidenceHash: '0x52a86001f64f04281fa0f60b58bff01ce31a0bac0851179ce5fc713d0406efdb', txs: [
    '0xb2df9e004772a7a9cec506c191d4478e1fc10e2f36e00ef8f07dd2335482bd22',
    '0x393ce2476966417f818eb70ef31d020752b79e0bdf3553cd8bd830e986b0dda3',
    '0x942fa12cf7c074870cbf08e711ea90935c877e9d99d62b421cdbeca18d3ac985',
    '0xf188603cf6d1fd17045477aea3e3032aefcb97f3abbad5c615a85dd4cbf7d13c',
    '0x554e2a83cbe1ce56e2a46b35eca0c7ccc39ecc1171efc45d0a58a23f9f33be11',
    '0x88cea6788a8f23017e8a74483e870228e6e6fa33d27c5fb1c47960eb0d7960e6',
  ] },
]
for (const address of [d.registry, d.escrow, d.vault, d.adapter])
  if (!await client.getCode({ address })) throw new Error(`No code at ${address}`)
for (const mission of evidence) {
  const on = await client.readContract({ address: d.escrow, abi: escrowAbi, functionName: 'getMission', args: [mission.id] })
  if (on.status !== 8 || on.outcome !== mission.outcome || on.evidenceHash.toLowerCase() !== mission.evidenceHash)
    throw new Error(`Mission #${mission.id} is not settled with its expected outcome and evidence hash`)
  for (const hash of mission.txs) {
    const receipt = await client.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`Failed transaction ${hash}`)
  }
  console.log(`Mission #${mission.id}: ${mission.outcome === 1 ? 'ProviderPaid' : 'BuyerRefunded'}, ${mission.txs.length} successful receipts, evidence hash matched`)
}
const [available, committed, netSpent, escrowHeld] = await Promise.all([
  client.readContract({ address: d.vault, abi: vaultAbi, functionName: 'availableOf', args: [operator] }),
  client.readContract({ address: d.vault, abi: vaultAbi, functionName: 'committedOf', args: [operator] }),
  client.readContract({ address: d.vault, abi: vaultAbi, functionName: 'netSpentOf', args: [operator] }),
  client.readContract({ address: d.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [d.escrow] }),
])
if (available !== 500_000n || committed !== 0n || netSpent !== 300_000n || escrowHeld !== 0n)
  throw new Error(`Unexpected vault/escrow balance: ${available}/${committed}/${netSpent}/${escrowHeld}`)
console.log('Four deployed contracts have code; vault 0.50 available / 0 committed / 0.30 net spent USDC; escrow holds 0 USDC')
