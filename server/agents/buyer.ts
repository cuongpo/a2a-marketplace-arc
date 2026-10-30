import { getAddress, recoverTypedDataAddress, type Address } from 'viem'
import { account, config } from '../env'
import { CHAIN_ID, escrowEvents, publicClient, requireDeployment, send, vaultRead, waitForHash } from '../chain'
import { audit, reliabilityOf } from '../store'
import { decodeEscrowLogs, recordTx } from './common'
import { PROVIDERS, quoteFor } from './provider'
import { agentBudgetVaultAbi } from '../../src/shared/abis'
import { quoteDomain, quoteTypes, unitIdOf } from '../../src/shared/typed'
import { hashCanonical } from '../../src/shared/canonical'
import type { MissionRecord, ScoredQuote, SignedQuote } from '../../src/shared/types'

/** Weights are stated in the audit trail so the ranking is inspectable, not magic. */
const W = { price: 0.4, capability: 0.25, reliability: 0.25, deadline: 0.1 }
const CAP_SCORE: Record<SignedQuote['evidenceCapability'], number> = {
  'signed-device+photo': 1,
  'signed-device': 0.8,
  'field-operator': 0.5,
}

const usdc = (b: bigint) => (Number(b) / 1e6).toFixed(2)

async function verifyQuote(q: SignedQuote): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({
      domain: quoteDomain(CHAIN_ID),
      types: quoteTypes,
      primaryType: 'Quote',
      message: {
        provider: q.provider,
        specHash: q.specHash,
        tileId: q.tileId,
        priceUsdc: BigInt(q.priceUsdc),
        etaSec: BigInt(q.etaSec),
        validUntil: BigInt(q.validUntil),
        capability: q.evidenceCapability,
      },
      signature: q.signature,
    })
    return getAddress(signer) === getAddress(q.provider)
  } catch {
    return false
  }
}

/** Request >= 2 signed quotes, verify signatures, rank, and record the decision with its rationale. */
export async function decide(m: MissionRecord) {
  const quotes: SignedQuote[] = []
  for (const p of PROVIDERS) quotes.push(await quoteFor(p, m.spec, m.specHash, m.scenario))
  m.quotes = quotes
  audit(m, 'buyer', `Requested quotes from ${quotes.length} provider agents; received ${quotes.length} signed quotes (simulated providers, real wallets)`)

  const fee = config.verifierFeeUsdc
  const budget = BigInt(m.spec.budgetUsdc)
  const now = Math.floor(Date.now() / 1000)
  const scored: ScoredQuote[] = []
  for (const q of quotes) {
    const price = BigInt(q.priceUsdc)
    let excluded: string | undefined
    if (!(await verifyQuote(q))) excluded = 'invalid quote signature'
    else if (q.validUntil < now) excluded = 'quote expired'
    else if (price + fee > budget) excluded = `price + verifier fee ${usdc(price + fee)} exceeds budget ${usdc(budget)} USDC`
    else if (now + q.etaSec > m.spec.deadlineUnix) excluded = 'cannot meet the deadline'
    const priceScore = Math.max(0, 1 - Number(price) / Math.max(1, Number(budget - fee)))
    const cap = CAP_SCORE[q.evidenceCapability]
    const rel = reliabilityOf(q.provider).score
    const dl = Math.max(0, Math.min(1, (m.spec.deadlineUnix - now - q.etaSec) / Math.max(1, m.spec.deadlineUnix - now)))
    const score = W.price * priceScore + W.capability * cap + W.reliability * rel + W.deadline * dl
    scored.push({ quote: q, score: Number(score.toFixed(4)), parts: { price: priceScore, capability: cap, reliability: rel, deadline: dl }, excluded })
  }
  scored.sort((a, b) => b.score - a.score)
  const eligible = scored.filter((s) => !s.excluded)
  if (eligible.length === 0) {
    m.stage = 'blocked'
    m.stageNote = 'No eligible quote within budget, deadline and signature checks'
    m.decision = undefined
    audit(m, 'buyer', m.stageNote, 'warn', { scored: scored.map((s) => ({ q: s.quote.quoteId, excluded: s.excluded })) })
    return
  }
  const top = eligible[0]
  const runner = eligible[1]
  const rationale =
    `Chose ${top.quote.providerName} at ${usdc(BigInt(top.quote.priceUsdc))} USDC (score ${top.score}). ` +
    (runner
      ? `Runner-up ${runner.quote.providerName} at ${usdc(BigInt(runner.quote.priceUsdc))} USDC scored ${runner.score}. `
      : 'Only one eligible quote. ') +
    `Weights: price ${W.price}, evidence capability ${W.capability}, historical reliability ${W.reliability}, deadline slack ${W.deadline}. ` +
    scored
      .filter((s) => s.excluded)
      .map((s) => `${s.quote.providerName} excluded: ${s.excluded}.`)
      .join(' ')
  m.decision = { chosenQuoteId: top.quote.quoteId, scored, rationale, at: Date.now() }
  m.stage = 'decided'
  audit(m, 'buyer', rationale, 'info', { chosen: top.quote.quoteId })
}

/** Reads the vault policy and reproduces the contract's checks so the agent only transacts if the vault permits it. */
export async function policyCheck(operator: Address, total: bigint): Promise<{ ok: boolean; reason?: string }> {
  const dep = requireDeployment()
  const buyer = account('buyer').address
  const pol = (await vaultRead<{ executor: Address; perMissionCap: bigint; totalCap: bigint; dailyCap: bigint; expiry: bigint; paused: boolean }>('policyOf', [operator]))
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (pol.executor.toLowerCase() !== buyer.toLowerCase()) return { ok: false, reason: 'this operator has not authorised the buyer agent as executor' }
  if (pol.paused) return { ok: false, reason: 'vault is paused by the operator' }
  if (pol.expiry < now) return { ok: false, reason: 'executor authority has expired' }
  if (!(await vaultRead<boolean>('escrowAllowed', [operator, dep.escrow]))) return { ok: false, reason: 'escrow is not allowlisted by the operator' }
  if (total > pol.perMissionCap) return { ok: false, reason: `mission total ${usdc(total)} exceeds per-mission cap ${usdc(pol.perMissionCap)} USDC` }
  const net = await vaultRead<bigint>('netSpentOf', [operator])
  if (net + total > pol.totalCap) return { ok: false, reason: `would exceed total cap ${usdc(pol.totalCap)} USDC (net spent ${usdc(net)})` }
  const day = now / 86400n
  const daily = await vaultRead<bigint>('dailySpentOf', [operator, day])
  if (daily + total > pol.dailyCap) return { ok: false, reason: `would exceed daily cap ${usdc(pol.dailyCap)} USDC (spent today ${usdc(daily)})` }
  const avail = await vaultRead<bigint>('availableOf', [operator])
  if (total > avail) return { ok: false, reason: `vault available balance ${usdc(avail)} USDC is below ${usdc(total)}` }
  return { ok: true }
}

export async function fund(m: MissionRecord, setHash: (h: `0x${string}`) => void, resumeHash?: `0x${string}`, attempts = 1) {
  if (!m.decision) throw new Error('no decision')
  const dep = requireDeployment()
  const chosen = m.decision.scored.find((s) => s.quote.quoteId === m.decision!.chosenQuoteId)!.quote
  const providerPrice = BigInt(chosen.priceUsdc)
  const verifierFee = config.verifierFeeUsdc
  const total = providerPrice + verifierFee

  const check = await policyCheck(m.operator, total)
  if (!check.ok) {
    m.stage = 'blocked'
    m.stageNote = `Vault policy blocked funding: ${check.reason}`
    audit(m, 'buyer', `${m.stageNote}. No transaction was sent.`, 'warn')
    return
  }

  const params = {
    objectiveHash: m.specHash,
    tileId: chosen.tileId,
    unit: unitIdOf(m.spec.unit),
    quoteHash: hashCanonical(chosen),
    provider: chosen.provider,
    verifier: account('verifier').address,
    refundTo: dep.vault,
    providerPrice,
    verifierFee,
    deadline: BigInt(m.spec.deadlineUnix),
    maxReadingAge: m.spec.maxReadingAgeSec,
    challengeWindow: m.spec.challengeWindowSec,
  }

  let receiptLogs
  let hash = resumeHash
  if (hash) {
    receiptLogs = await waitForHash(hash)
  } else {
    // Crash-safety: on a RETRY (attempts > 1, no recorded tx hash) an earlier attempt may have broadcast
    // before crashing. Search for an existing mission with this objective hash and adopt it instead of paying
    // twice. If the search itself fails we throw and retry later; we never send blind.
    const head = await publicClient.getBlockNumber()
    const recent = attempts > 1 ? await escrowEvents(head > 3000n ? head - 3000n : 0n) : []
    const dup = recent.find((e) => e.eventName === 'MissionCreated' && String(e.args.objectiveHash) === m.specHash && String(e.args.buyer).toLowerCase() === dep.vault.toLowerCase())
    if (dup) {
      audit(m, 'buyer', 'Found an existing onchain mission for this objective hash; adopting it (no second payment)', 'warn')
      receiptLogs = await waitForHash(dup.transactionHash)
      hash = dup.transactionHash
    } else {
      const sent = await send(
        'buyer',
        { address: dep.vault, abi: agentBudgetVaultAbi, functionName: 'createMissionFor', args: [m.operator, dep.escrow, params] },
        { onHash: setHash },
      )
      receiptLogs = sent.receipt
      hash = sent.hash
    }
  }
  const created = decodeEscrowLogs(receiptLogs, dep.escrow).find((e) => e.eventName === 'MissionCreated')
  if (!created) throw new Error('MissionCreated event not found in receipt')
  const onchainId = String(created.args.id)
  const block = await publicClient.getBlock({ blockNumber: receiptLogs.blockNumber })
  m.chain = {
    chainId: CHAIN_ID,
    escrow: dep.escrow,
    onchainId,
    provider: chosen.provider,
    verifier: account('verifier').address,
    providerPrice: providerPrice.toString(),
    verifierFee: verifierFee.toString(),
    deadline: m.spec.deadlineUnix,
    createdBlock: receiptLogs.blockNumber.toString(),
    createdAtChain: Number(block.timestamp),
  }
  m.stage = 'funded'
  recordTx(m, 'buyer agent funds mission from vault', hash, 'buyer', receiptLogs)
  audit(m, 'buyer', `Vault funded mission #${onchainId} in escrow: ${usdc(providerPrice)} USDC provider price + ${usdc(verifierFee)} USDC verifier fee (within policy)`, 'info', { txHash: hash })
}
