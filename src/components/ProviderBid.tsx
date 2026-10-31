import { useEffect, useState } from 'react'
import { useAccount, useSignTypedData, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { Gavel, Wallet } from 'lucide-react'
import { parseUsdc } from '@/onchain-money'
import { useSignedPost } from '@/lib/auth'
import { quoteDomain, quoteTypes, tileIdOf } from '@/shared/typed'
import { usdc, type Overview, type PMission } from '@/lib/api'
import { ErrorBox } from './ui'

export function ProviderBid({ m, ov, onChange }: { m: PMission; ov: Overview | null; onChange: () => void }) {
  const { address, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { signTypedDataAsync } = useSignTypedData()
  const post = useSignedPost()
  const [name, setName] = useState('Independent Provider')
  const [price, setPrice] = useState('0.50')
  const [eta, setEta] = useState('300')
  const [capability, setCapability] = useState<'signed-device' | 'signed-device+photo' | 'field-operator'>('field-operator')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer) }, [])
  const closes = m.quoteDeadlineUnix ?? 0
  const open = m.stage === 'quoting' && closes > now
  const submitted = m.quotes.some((q) => q.provider.toLowerCase() === address?.toLowerCase())
  if (!m.quoteDeadlineUnix || m.decision || m.stage === 'blocked') return null

  async function submit() {
    if (!address || !ov) return
    setBusy(true)
    setError(null)
    try {
      const priceUsdc = parseUsdc(price)
      if (priceUsdc <= 0n || priceUsdc + BigInt(ov.verifierFeeUsdc) > BigInt(m.spec.budgetUsdc)) throw new Error('Bid plus verifier fee must fit the request budget')
      if (chainId !== ov.chainId) await switchChainAsync({ chainId: ov.chainId })
      const etaSec = Number(eta)
      const validUntil = m.spec.deadlineUnix
      const tileId = tileIdOf(m.spec.tile)
      const signature = await signTypedDataAsync({
        domain: quoteDomain(ov.chainId), types: quoteTypes, primaryType: 'Quote',
        message: { provider: address, specHash: m.specHash, tileId, priceUsdc, etaSec: BigInt(etaSec), validUntil: BigInt(validUntil), capability },
      })
      await post(`/missions/${m.id}/quotes`, {
        provider: address, providerName: name.trim(), priceUsdc: priceUsdc.toString(), etaSec,
        evidenceCapability: capability, validUntil, tileId, specHash: m.specHash, signature,
      })
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bid failed')
    } finally {
      setBusy(false)
    }
  }

  return <div className="inset space-y-3 p-3" aria-label="Provider bid form">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="label">Open provider auction</div><span className="mono text-xs text-[var(--warn)]">Closes {new Date(closes * 1000).toLocaleTimeString()}</span></div>
    <p className="text-xs text-[var(--muted)]">Any wallet can bid. The buyer agent checks your EIP-712 signature, price, delivery time, capability and past reliability. The winner must accept and deliver with its own wallet. Maximum request budget: {usdc(m.spec.budgetUsdc)} USDC.</p>
    {!address ? <ConnectKitButton.Custom>{({ show }) => <button type="button" className="btn btn-ghost" onClick={show}><Wallet size={15} /> Connect provider wallet</button>}</ConnectKitButton.Custom> : submitted ? <p className="text-xs text-[var(--success)]">This wallet submitted a signed bid. Waiting for the auction to close.</p> : <>
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs text-[var(--subtle)]">Provider name<input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} className="mt-1" /></label><label className="text-xs text-[var(--subtle)]">Price in USDC<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1" /></label></div>
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-xs text-[var(--subtle)]">Delivery ETA<select value={eta} onChange={(e) => setEta(e.target.value)} className="mt-1"><option value="300">5 minutes</option><option value="600">10 minutes</option><option value="1200">20 minutes</option></select></label><label className="text-xs text-[var(--subtle)]">Evidence capability<select value={capability} onChange={(e) => setCapability(e.target.value as typeof capability)} className="mt-1"><option value="field-operator">Wallet-signed manual data</option><option value="signed-device">Registered device signer</option><option value="signed-device+photo">Device signer + photo hash</option></select></label></div>
      <button type="button" className="btn btn-primary" disabled={!open || busy || !ov?.deployed} onClick={() => void submit()}><Gavel size={15} /> {busy ? 'Sign bid and request...' : open ? 'Sign and submit bid' : 'Bidding closed'}</button>
    </>}
    {error ? <ErrorBox message={error} /> : null}
  </div>
}
