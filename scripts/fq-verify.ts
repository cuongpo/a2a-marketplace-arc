// Independent verification of every confirmed mission transaction against the PUBLIC chain.
// For each tx in the backend's mission records it re-fetches the receipt (status, block), decodes the
// USDC ERC-20 Transfer logs emitted by the USDC contract, and counts (but does NOT sum) EIP-7708 system
// Transfer logs, so the one underlying USDC balance is never double counted.
// Usage: bun run scripts/fq-verify.ts [--json out.json]   (backend must be running)
import { decodeEventLog, parseAbiItem, getAddress } from 'viem'
import { writeFileSync } from 'node:fs'
import { explorerBase, publicClient, requireDeployment, usdcAddress, usdcBalance } from '../server/chain'
import { formatUsdc } from '../src/onchain-money'
import { missionEscrowAbi } from '../src/shared/abis'
import type { MissionRecord } from '../src/shared/types'

const API = process.env.FQ_API ?? 'http://127.0.0.1:3001'
const SYSTEM_EMITTER = getAddress('0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE')
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const dep = requireDeployment()

const label = new Map<string, string>()
const ov = (await (await fetch(`${API}/overview`)).json()) as { wallets: { label: string; address: string }[] }
for (const w of ov.wallets) label.set(w.address.toLowerCase(), w.label)
label.set(dep.escrow.toLowerCase(), 'MissionEscrow')
label.set(dep.vault.toLowerCase(), 'AgentBudgetVault')
const who = (a: string) => label.get(a.toLowerCase()) ?? a

const missions = ((await (await fetch(`${API}/missions`)).json()) as MissionRecord[]).reverse()
const report: unknown[] = []
let failures = 0
for (const m of missions) {
  if (!m.chain) continue
  console.log(`\n=== mission #${m.chain.onchainId} tile ${m.spec.tile} (${m.scenario}) local ${m.id}`)
  const entry: Record<string, unknown> = { id: m.id, onchainId: m.chain.onchainId, tile: m.spec.tile, scenario: m.scenario, txs: [] }
  for (const t of m.txs) {
    const r = await publicClient.getTransactionReceipt({ hash: t.hash })
    const ok = r.status === 'success'
    if (!ok) failures++
    const transfers: string[] = []
    let system = 0
    for (const l of r.logs) {
      if (l.address.toLowerCase() === SYSTEM_EMITTER.toLowerCase()) {
        system++
        continue
      }
      if (l.address.toLowerCase() !== usdcAddress.toLowerCase()) continue
      try {
        const ev = decodeEventLog({ abi: [transfer], data: l.data, topics: l.topics })
        transfers.push(`${who(ev.args.from)} -> ${who(ev.args.to)}: ${formatUsdc(ev.args.value)} USDC`)
      } catch {
        /* other USDC event */
      }
    }
    console.log(`${ok ? 'OK  ' : 'FAIL'} block ${r.blockNumber} ${t.label}\n       ${explorerBase}/tx/${t.hash}`)
    for (const x of transfers) console.log(`       USDC ERC-20 Transfer: ${x}`)
    if (system) console.log(`       (${system} EIP-7708 system log(s) present; same funds, not added)`)
    ;(entry.txs as unknown[]).push({ label: t.label, hash: t.hash, status: r.status, block: r.blockNumber.toString(), usdcTransfers: transfers, systemLogs: system })
  }
  const on = await publicClient.readContract({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'getMission', args: [BigInt(m.chain.onchainId)] })
  const st = ['None', 'Funded', 'Assigned', 'Submitted', 'Accepted', 'Rejected', 'Challenged', 'Expired', 'Settled'][on.status]
  const oc = ['None', 'ProviderPaid', 'BuyerRefunded', 'Split', 'Expired'][on.outcome]
  console.log(`onchain status ${st}, outcome ${oc}, refundAmount ${formatUsdc(await publicClient.readContract({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'refundAmount', args: [BigInt(m.chain.onchainId)] }))}`)
  entry.onchain = { status: st, outcome: oc }
  report.push(entry)
}

console.log('\n=== balances now (ERC-20 view, 6 decimals)')
for (const w of ov.wallets) console.log(`${w.label.padEnd(40)} ${formatUsdc(await usdcBalance(w.address as `0x${string}`))} USDC`)
console.log(`${'MissionEscrow'.padEnd(40)} ${formatUsdc(await usdcBalance(dep.escrow))} USDC held; liabilities ${formatUsdc(await publicClient.readContract({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'totalLiabilities' }))}`)
console.log(failures ? `\n${failures} FAILED receipt(s)` : '\nall receipts succeeded')
const out = process.argv.indexOf('--json')
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2))
process.exit(failures ? 1 : 0)
