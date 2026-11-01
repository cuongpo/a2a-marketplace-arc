// Publish exact Solidity source matches for the deployed Arc Mainnet contracts.
// No wallet key is loaded or transaction sent. --publish submits public source to Sourcify.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const dep = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
if (dep.chainId !== 5042) throw new Error('Not Arc Mainnet')
const contracts = [
  ['EvidenceRegistry', 'registry'], ['MissionEscrow', 'escrow'],
  ['AgentBudgetVault', 'vault'], ['Erc8004Adapter', 'adapter'],
]
const publish = process.argv.includes('--publish')
if (process.argv.some((arg, i) => i > 1 && arg !== '--publish')) throw new Error('Only --publish is supported')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const [name, field] of contracts) {
  const address = dep[field]
  const txHash = dep.deployTxs?.[field]
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) throw new Error(`${name} deployment details missing`)
  const lookupUrl = `https://sourcify.dev/server/v2/contract/5042/${address}`
  const existing = await fetch(lookupUrl)
  if (existing.ok) {
    const status = await existing.json()
    if (status.creationMatch === 'exact_match' && status.runtimeMatch === 'exact_match') {
      console.log(`${name} already exact-match verified: https://repo.sourcify.dev/5042/${address}`)
      continue
    }
  }
  console.log(`${name} ${address}: ${publish ? 'submitting source' : 'source publication pending'}`)
  if (!publish) continue
  const artifact = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, 'utf8'))
  const path = `contracts/${name}.sol`
  const stdJsonInput = JSON.parse(execFileSync('forge', ['verify-contract', address, `${path}:${name}`, '--chain-id', '5042', '--show-standard-json-input'], { encoding: 'utf8', maxBuffer: 10_000_000 }))
  const res = await fetch(`https://sourcify.dev/server/v2/verify/5042/${address}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stdJsonInput, compilerVersion: artifact.metadata.compiler.version, contractIdentifier: `${path}:${name}`, creationTransactionHash: txHash }),
  })
  const accepted = await res.json()
  if (!res.ok || !accepted.verificationId) throw new Error(`${name} Sourcify submission failed: ${JSON.stringify(accepted).slice(0, 400)}`)
  let completed = false
  for (let i = 0; i < 30; i++) {
    const job = await (await fetch(`https://sourcify.dev/server/v2/verify/${accepted.verificationId}`)).json()
    if (!job.isJobCompleted) { await wait(2000); continue }
    if (job.contract?.creationMatch !== 'exact_match' || job.contract?.runtimeMatch !== 'exact_match')
      throw new Error(`${name} source did not exactly match deployment: ${JSON.stringify(job.contract ?? job.error).slice(0, 400)}`)
    console.log(`${name} exact creation/runtime match: https://repo.sourcify.dev/5042/${address}`)
    completed = true
    break
  }
  if (!completed) throw new Error(`${name} Sourcify verification timed out; inspect ticket ${accepted.verificationId}`)
}
console.log(publish ? 'Sourcify verification complete.' : 'Dry run complete. No source was submitted.')
