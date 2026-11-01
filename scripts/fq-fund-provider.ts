// Sends a small amount of test USDC (for gas) from the demo operator wallet to an external provider wallet.
// Hard caps: at most 0.04 USDC per call, and nothing is sent if the target already holds at least the requested amount.
// Testnet only. Usage: bun run scripts/fq-fund-provider.ts <0xProviderWallet> <amountUsdc>
import { isAddress, getAddress } from 'viem'
import { account } from '../server/env'
import { CHAIN_ID, erc20Abi, explorerBase, send, usdcAddress, usdcBalance } from '../server/chain'
import { formatUsdc, parseUsdc } from '../src/onchain-money'

if (CHAIN_ID !== 5042002) throw new Error('testnet only')
const [, , to, amount] = process.argv
if (!to || !isAddress(to) || !amount) throw new Error('usage: fq-fund-provider.ts <0xWallet> <amountUsdc>')
const want = parseUsdc(amount)
if (want <= 0n || want > parseUsdc('0.04')) throw new Error('amount must be > 0 and at most 0.04 USDC')
const target = getAddress(to)
const have = await usdcBalance(target)
console.log(`target ${target} holds ${formatUsdc(have)} USDC`)
if (have >= want) {
  console.log('already funded; nothing sent')
  process.exit(0)
}
const op = account('operator').address
if ((await usdcBalance(op)) < want + parseUsdc('0.05')) throw new Error('operator balance too low')
const { hash } = await send('operator', { address: usdcAddress, abi: erc20Abi, functionName: 'transfer', args: [target, want] })
console.log(`sent ${formatUsdc(want)} USDC: ${explorerBase}/tx/${hash}`)
console.log(`target now holds ${formatUsdc(await usdcBalance(target))} USDC`)
