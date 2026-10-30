// One-time TESTNET setup: fund role wallets with gas USDC, deposit the operator budget into the vault,
// authorise the buyer agent under hard caps, allowlist the escrow, bind sensor keys to providers.
// Idempotent: re-running skips what is already done. Usage: bun run fq:setup [--with-8004]
import { account } from '../server/env'
import { CHAIN_ID, erc20Abi, explorerBase, publicClient, registryRead, requireDeployment, send, usdcAddress, usdcBalance, vaultRead } from '../server/chain'
import { agentBudgetVaultAbi, erc8004AdapterAbi, evidenceRegistryAbi } from '../src/shared/abis'
import { registryDomain, signerBindingTypes } from '../src/shared/typed'
import { formatUsdc, parseUsdc } from '../src/onchain-money'
import { hashText } from '../src/shared/canonical'
import { decodeEventLog, type Address, type Hex } from 'viem'

const dep = requireDeployment()
if (CHAIN_ID !== 5042002) throw new Error('fq:setup is testnet-only')
const withdraw8004 = process.argv.includes('--with-8004')
const FORK = !!process.env.FQ_RPC_URL_OVERRIDE
if (FORK) console.log('LOCAL FORK MODE: transactions below exist only on the local fork, not on the public testnet.')
const tx = (h: Hex) => (FORK ? `(fork tx ${h})` : `${explorerBase}/tx/${h}`)

const GAS_FLOAT: Array<[Parameters<typeof account>[0], string]> = [
  ['buyer', '0.50'],
  ['providerA', '0.30'],
  ['providerB', '0.30'],
  ['verifier', '0.60'],
  ['arbiter', '0.20'],
]
const VAULT_DEPOSIT = parseUsdc(process.env.FQ_VAULT_DEPOSIT ?? '3')
const need = GAS_FLOAT.reduce((s, [, a]) => s + parseUsdc(a), 0n) + VAULT_DEPOSIT + parseUsdc('0.30')

const op = account('operator').address
const opBal = await usdcBalance(op)
console.log(`operator ${op} USDC (ERC-20 view): ${formatUsdc(opBal)}; setup needs about ${formatUsdc(need)}`)
const vaultAvail = await vaultRead<bigint>('availableOf', [op])
if (opBal + vaultAvail < need) {
  console.log(`\nNOT ENOUGH TESTNET USDC. Fund the operator wallet ${op} with at least ${formatUsdc(need - opBal - vaultAvail)} more USDC on Arc Testnet`)
  console.log('(use the Arc Studio sidebar "Get test USDC" then send to this address, or https://faucet.circle.com), then re-run: bun run fq:setup')
  process.exit(2)
}

for (const [role, amt] of GAS_FLOAT) {
  const a = account(role).address
  const bal = await usdcBalance(a)
  const want = parseUsdc(amt)
  if (bal >= want) continue
  const { hash } = await send('operator', { address: usdcAddress, abi: erc20Abi, functionName: 'transfer', args: [a, want - bal] })
  console.log(`funded ${role} ${a} with ${formatUsdc(want - bal)} USDC  ${tx(hash)}`)
}

const allowance = await publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: 'allowance', args: [op, dep.vault] })
const toDeposit = vaultAvail >= VAULT_DEPOSIT ? 0n : VAULT_DEPOSIT - vaultAvail
if (toDeposit > 0n) {
  if (allowance < toDeposit) {
    const { hash } = await send('operator', { address: usdcAddress, abi: erc20Abi, functionName: 'approve', args: [dep.vault, toDeposit] })
    console.log(`operator approved vault for ${formatUsdc(toDeposit)} USDC  ${tx(hash)}`)
  }
  const { hash } = await send('operator', { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'deposit', args: [toDeposit] })
  console.log(`operator deposited ${formatUsdc(toDeposit)} USDC into vault  ${tx(hash)}`)
}

const pol = await vaultRead<{ executor: Address; expiry: bigint }>('policyOf', [op])
const buyer = account('buyer').address
const nowSec = BigInt(Math.floor(Date.now() / 1000))
if (pol.executor.toLowerCase() !== buyer.toLowerCase() || pol.expiry < nowSec + 86_400n) {
  const { hash } = await send('operator', {
    address: dep.vault,
    abi: agentBudgetVaultAbi,
    functionName: 'setPolicy',
    args: [buyer, parseUsdc('1.5'), parseUsdc('10'), parseUsdc('5'), nowSec + 30n * 86_400n],
  })
  console.log(`operator authorised buyer agent (per-mission 1.5, total 10, daily 5 USDC, 30 days)  ${tx(hash)}`)
}
if (!(await vaultRead<boolean>('escrowAllowed', [op, dep.escrow]))) {
  const { hash } = await send('operator', { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'setEscrowAllowed', args: [dep.escrow, true] })
  console.log(`operator allowlisted escrow  ${tx(hash)}`)
}

// Bind each SIMULATED device key to its provider (device countersigns the binding).
for (const [prov, sensor] of [['providerA', 'sensorA'], ['providerB', 'sensorB']] as const) {
  const s = account(sensor)
  const info = await registryRead<readonly [Address, boolean, Hex]>('signerInfo', [s.address])
  if (info[1]) continue
  const metadataHash = hashText(`FQ-SIM-GAUGE ${sensor} (simulated fixture device, testnet only)`)
  const signerSig = await s.signTypedData({
    domain: registryDomain(CHAIN_ID, dep.registry),
    types: signerBindingTypes,
    primaryType: 'SignerBinding',
    message: { provider: account(prov).address, signer: s.address, metadataHash },
  })
  const { hash } = await send(prov, { address: dep.registry, abi: evidenceRegistryAbi, functionName: 'registerSigner', args: [s.address, metadataHash, signerSig] })
  console.log(`${prov} registered simulated device key ${s.address}  ${tx(hash)}`)
}

if (withdraw8004 && dep.identityRegistry && dep.adapter) {
  const idAbi = [
    { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ type: 'uint256' }] },
    { type: 'event', name: 'Registered', inputs: [{ name: 'agentId', type: 'uint256', indexed: true }, { name: 'agentURI', type: 'string', indexed: false }, { name: 'owner', type: 'address', indexed: true }] },
  ] as const
  for (const role of ['providerA', 'providerB', 'verifier'] as const) {
    try {
      const card = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: `FieldQuest ${role}`, description: 'FieldQuest testnet demo agent (simulated provider/verifier logic, real wallet).', services: [], x402Support: false, active: true }
      const uri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(card)).toString('base64')
      const { hash, receipt } = await send(role, { address: dep.identityRegistry, abi: idAbi, functionName: 'register', args: [uri] })
      let agentId: bigint | undefined
      for (const l of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: idAbi, data: l.data, topics: l.topics })
          if (ev.eventName === 'Registered') agentId = ev.args.agentId
        } catch { /* other log */ }
      }
      console.log(`${role} registered ERC-8004 identity ${agentId}  ${tx(hash)}`)
      if (agentId !== undefined) {
        const b = await send(role, { address: dep.adapter, abi: erc8004AdapterAbi, functionName: 'bindAgent', args: [agentId] })
        console.log(`${role} bound agent ${agentId} in the adapter  ${tx(b.hash)}`)
      }
    } catch (e) {
      console.log(`ERC-8004 step for ${role} skipped: ${(e as Error).message.slice(0, 160)}`)
    }
  }
}
console.log('setup complete')
