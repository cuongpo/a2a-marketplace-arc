// Read-only verification for the open-agent-network demo: re-fetches every listed transaction from the PUBLIC chain,
// checks its receipt status, decodes USDC ERC-20 Transfer logs (EIP-7708 system logs are counted, never summed) and the
// marketplace adapter's FeedbackRecorded/FeedbackFailed events, then reads each agent's adapter-filtered reputation.
// Usage: bun run scripts/fq-verify-network.ts <hashes.txt> [out.json]      (one "label<TAB>0xhash" per line)
import { readFileSync, writeFileSync } from 'node:fs'
import { decodeEventLog, getAddress, parseAbiItem, type Hex } from 'viem'
import { explorerBase, publicClient, requireDeployment, usdcAddress } from '../server/chain'
import { liveNetworkDeps } from '../server/network'
import { parseFeedbackLogs } from '../server/feedback'
import { formatUsdc } from '../src/onchain-money'

const dep = requireDeployment()
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const SYSTEM = getAddress('0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE')
const names = new Map<string, string>([
  [dep.escrow, 'MissionEscrow'], [dep.vault, 'AgentBudgetVault'], [usdcAddress, 'USDC'],
  ...(process.env.FQ_LABELS ?? '').split(',').filter(Boolean).map((p) => p.split('=') as [string, string]),
])
const who = (a: string) => names.get(getAddress(a)) ?? names.get(a) ?? a
const lines = readFileSync(process.argv[2] ?? '/dev/stdin', 'utf8').split('\n').filter(Boolean)
const out: unknown[] = []
let fail = 0
for (const line of lines) {
  const [label, hash] = line.split('\t')
  const r = await publicClient.getTransactionReceipt({ hash: hash as Hex })
  const ok = r.status === 'success'
  if (!ok) fail++
  const transfers: string[] = []
  let system = 0
  for (const l of r.logs) {
    if (l.address.toLowerCase() === SYSTEM.toLowerCase()) system++
    else if (l.address.toLowerCase() === usdcAddress.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: [transfer], data: l.data, topics: l.topics })
        transfers.push(`${who(ev.args.from)} -> ${who(ev.args.to)}: ${formatUsdc(ev.args.value)} USDC`)
      } catch {
        /* other USDC event */
      }
    }
  }
  const fb = dep.adapter ? parseFeedbackLogs(r, dep.adapter) : []
  console.log(`${ok ? 'OK  ' : 'FAIL'} block ${r.blockNumber} ${label}\n       ${explorerBase}/tx/${hash}`)
  for (const t of transfers) console.log(`       USDC ERC-20 Transfer: ${t}`)
  for (const f of fb) console.log(`       adapter ${f.outcome === 'recorded' ? 'FeedbackRecorded' : 'FeedbackFailed'}: ${f.role} agent #${f.agentId}${f.value ? ` value ${f.value}` : ''}`)
  if (system) console.log(`       (${system} EIP-7708 system log(s); same funds, not added)`)
  out.push({ label, hash, status: r.status, block: r.blockNumber.toString(), usdcTransfers: transfers, adapterFeedback: fb, systemLogs: system })
}
console.log('\nAdapter-filtered ERC-8004 reputation (registry getSummary/readAllFeedback with clients=[adapter], tag fieldquest.delivery):')
for (const id of (process.env.FQ_AGENT_IDS ?? '').split(',').filter(Boolean)) {
  const rep = await liveNetworkDeps.reputation(BigInt(id))
  console.log(`  agent #${id}: ${rep.count} record(s), mean value ${rep.avgValue ?? 'n/a'}`)
  out.push({ agentId: id, reputation: rep })
}
console.log(fail ? `\n${fail} FAILED receipt(s)` : '\nall receipts succeeded')
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out, null, 2))
process.exit(fail ? 1 : 0)
