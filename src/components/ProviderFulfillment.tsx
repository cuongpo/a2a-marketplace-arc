import { useState } from 'react'
import { useAccount, usePublicClient, useReadContract, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi'
import { Fingerprint, Send, Wallet } from 'lucide-react'
import type { Address, Hex } from 'viem'
import { hashCanonical } from '@/shared/canonical'
import { missionEscrowAbi, evidenceRegistryAbi } from '@/shared/abis'
import { readingTypes, registryDomain, signerBindingTypes, tileIdOf, unitIdOf } from '@/shared/typed'
import { useSignedPost } from '@/lib/auth'
import { type Overview, type PMission } from '@/lib/api'
import { ErrorBox, TxLink } from './ui'

export function ProviderFulfillment({ m, ov, onChange }: { m: PMission; ov: Overview | null; onChange: () => void }) {
  const winner = m.decision?.scored.find((s) => s.quote.quoteId === m.decision?.chosenQuoteId)?.quote
  const external = !!winner && !winner.simulated
  const { address, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const client = usePublicClient({ chainId: ov?.chainId })
  const post = useSignedPost()
  const [value, setValue] = useState('420')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastHash, setLastHash] = useState<Hex | null>(null)
  const bound = !!address && !!m.chain && address.toLowerCase() === m.chain.provider.toLowerCase()
  const info = useReadContract({ address: ov?.contracts?.registry as Address | undefined, abi: evidenceRegistryAbi, functionName: 'signerInfo', args: address ? [address] : undefined, chainId: ov?.chainId, query: { enabled: external && bound && !!ov?.contracts?.registry && !!address, refetchInterval: 5000 } })
  const credit = useReadContract({ address: ov?.contracts?.escrow as Address | undefined, abi: missionEscrowAbi, functionName: 'credits', args: address ? [address] : undefined, chainId: ov?.chainId, query: { enabled: external && bound && !!ov?.contracts?.escrow && !!address, refetchInterval: 5000 } })
  const signerInfo = info.data
  const signerReady = !!signerInfo && !!address && signerInfo[0].toLowerCase() === address.toLowerCase() && signerInfo[1]

  if (!external || !m.chain || !ov?.contracts) return null

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key)
    setError(null)
    try { await fn(); onChange(); void info.refetch(); void credit.refetch() }
    catch (e) { setError(e instanceof Error ? e.message : 'Wallet action failed') }
    finally { setBusy(null) }
  }
  async function confirm(write: () => Promise<Hex>) {
    if (!ov || !address) throw new Error('Connect the winning provider wallet')
    if (chainId !== ov.chainId) await switchChainAsync({ chainId: ov.chainId })
    const hash = await write()
    setLastHash(hash)
    const receipt = await client?.waitForTransactionReceipt({ hash })
    if (!receipt || receipt.status !== 'success') throw new Error('The transaction was not confirmed successfully')
  }
  async function register() {
    if (!address || !ov?.contracts) throw new Error('Connect the winning provider wallet')
    if (chainId !== ov.chainId) await switchChainAsync({ chainId: ov.chainId })
    const metadataHash = hashCanonical({ kind: 'manual-wallet-signer', provider: address })
    const sig = await signTypedDataAsync({ domain: registryDomain(ov.chainId, ov.contracts.registry as Address), types: signerBindingTypes, primaryType: 'SignerBinding', message: { provider: address, signer: address, metadataHash } })
    await confirm(() => writeContractAsync({ address: ov.contracts!.registry as Address, abi: evidenceRegistryAbi, functionName: 'registerSigner', args: [address, metadataHash, sig], chainId: ov.chainId }))
  }
  async function prepare() {
    if (!address || !ov?.contracts || !m.chain) throw new Error('Connect the winning provider wallet')
    if (!signerReady) throw new Error('Register this wallet as a signer first, or paste evidence signed by your registered device key')
    if (!/^\d{1,8}$/.test(value)) throw new Error('Enter a whole-number reading in mm')
    if (chainId !== ov.chainId) await switchChainAsync({ chainId: ov.chainId })
    const observedAt = Math.max(Math.floor(Date.now() / 1000), (m.onchain?.createdAt ?? 0) + 1)
    const bytes = crypto.getRandomValues(new Uint32Array(2))
    const nonce = ((BigInt(bytes[0]) << 32n) | BigInt(bytes[1])).toString()
    const rawPayload = { source: 'manual-provider-wallet', valueMm: Number(value), request: m.spec.tile, observedAt }
    const reading = {
      missionId: m.chain.onchainId, tileId: tileIdOf(m.spec.tile), observedAt, value,
      unit: unitIdOf(m.spec.unit), nonce, payloadHash: hashCanonical(rawPayload),
    }
    const signature = await signTypedDataAsync({
      domain: registryDomain(ov.chainId, ov.contracts.registry as Address), types: readingTypes, primaryType: 'Reading',
      message: { missionId: BigInt(reading.missionId), tileId: reading.tileId, observedAt: BigInt(reading.observedAt), value: BigInt(reading.value), unit: reading.unit, nonce: BigInt(reading.nonce), payloadHash: reading.payloadHash },
    })
    await post(`/missions/${m.id}/observation`, { reading, signature, rawPayload, kind: 'field-operator-upload', operatorNote: 'Manual wallet-signed data; not an independent sensor measurement' })
  }
  async function commit() {
    if (!m.chain || !m.evidencePreview || !m.evidenceHash || !ov?.contracts) throw new Error('Prepare the signed evidence first')
    const r = m.evidencePreview.reading
    await confirm(() => writeContractAsync({ address: ov.contracts!.escrow as Address, abi: missionEscrowAbi, functionName: 'submitEvidence', args: [BigInt(m.chain!.onchainId), m.evidenceHash!,
      { missionId: BigInt(r.missionId), tileId: r.tileId, observedAt: BigInt(r.observedAt), value: BigInt(r.value), unit: r.unit, nonce: BigInt(r.nonce), payloadHash: r.payloadHash },
      m.evidencePreview!.signature], chainId: ov.chainId }))
  }

  return <div className="inset space-y-3 p-3" aria-label="External provider fulfillment">
    <div className="label">Winning provider · wallet actions</div>
    <p className="text-xs text-[var(--muted)]">{winner?.providerName} won the signed auction. The backend cannot sign or spend from this provider wallet.</p>
    {!bound ? <p className="flex items-center gap-2 text-xs text-[var(--warn)]"><Wallet size={14} /> Connect winner wallet {m.chain.provider.slice(0, 8)}...{m.chain.provider.slice(-6)} to continue.</p> : null}
    {m.onchain?.status === 'Funded' ? <button type="button" className="btn btn-primary" disabled={!bound || !!busy} onClick={() => void run('accept', () => confirm(() => writeContractAsync({ address: ov.contracts!.escrow as Address, abi: missionEscrowAbi, functionName: 'acceptAssignment', args: [BigInt(m.chain!.onchainId)], chainId: ov.chainId })))}><Fingerprint size={15} /> {busy === 'accept' ? 'Confirming...' : 'Accept job onchain'}</button> : null}
    {m.onchain?.status === 'Assigned' ? <>
      <div className="text-xs text-[var(--subtle)]">Signer: {signerReady ? 'wallet registered and active' : 'register this wallet for manual data, or use a separately registered device key'}</div>
      {bound && !signerReady ? <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void run('register', register)}>{busy === 'register' ? 'Registering...' : 'Register wallet as data signer'}</button> : null}
      {!m.evidenceHash ? <div className="flex flex-wrap items-end gap-2"><label className="text-xs text-[var(--subtle)]">Manual water-level reading (mm)<input className="mt-1 !w-36" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></label><button type="button" className="btn btn-ghost" disabled={!bound || !signerReady || !!busy} onClick={() => void run('prepare', prepare)}>{busy === 'prepare' ? 'Signing...' : 'Sign and prepare evidence'}</button></div> : null}
      {m.evidenceHash && m.evidencePreview ? <button type="button" className="btn btn-primary" disabled={!bound || !!busy} onClick={() => void run('commit', commit)}><Send size={15} /> {busy === 'commit' ? 'Confirming...' : 'Commit evidence onchain'}</button> : null}
      <p className="text-[11px] text-[var(--subtle)]">Manual wallet signing proves account control, not that a physical sensor measured this value. For an external device, use the signed JSON upload in the evidence section.</p>
    </> : null}
    {m.onchain?.status === 'Settled' && m.onchain.outcome === 'ProviderPaid' && bound && BigInt((credit.data) ?? 0n) > 0n ? <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void run('withdraw', () => confirm(() => writeContractAsync({ address: ov.contracts!.escrow as Address, abi: missionEscrowAbi, functionName: 'withdraw', args: [address], chainId: ov.chainId })))}>Withdraw credited USDC</button> : null}
    {lastHash ? <p className="text-xs text-[var(--subtle)]">Confirmed transaction: <TxLink chainId={ov.chainId} hash={lastHash} /></p> : null}
    {error ? <ErrorBox message={error} /> : null}
  </div>
}
