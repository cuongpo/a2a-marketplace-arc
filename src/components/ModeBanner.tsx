import type { Overview } from '@/lib/api'

/** Always visible. Reflects the network the backend is actually configured for. */
export function ModeBanner({ ov, error }: { ov: Overview | null; error: string | null }) {
  if (error && !ov) {
    return (
      <div role="status" className="border-b border-[rgba(232,109,122,0.4)] bg-[rgba(232,109,122,0.1)] px-4 py-2 text-center text-xs text-[var(--danger)]">
        Backend unreachable ({error}). Start it with <span className="mono">bun run server</span>. No data below is live.
      </div>
    )
  }
  if (!ov) return <div className="h-8 border-b border-white/10" />
  const main = ov.network === 'mainnet'
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${
        main ? 'border-[rgba(232,109,122,0.6)] bg-[rgba(232,109,122,0.16)] text-[var(--danger)]' : 'border-[rgba(241,194,122,0.4)] bg-[rgba(241,194,122,0.09)] text-[var(--warn)]'
      }`}
    >
      <span>{main ? 'ARC MAINNET: REAL USDC' : 'ARC TESTNET: TEST USDC, NO REAL VALUE'}</span>
      {ov.readOnly ? <span className="font-normal opacity-80">{ov.archived ? 'public pilot archive · latest stored snapshot; verify current state on Arc Explorer' : 'public read-only pilot · chain reads and receipts are live'}</span> : null}
      <span className="mono font-normal opacity-80">chain {ov.chainId}</span>
      <span className="font-normal opacity-80">{ov.contracts ? 'contracts deployed' : 'contracts not deployed for this network'}</span>
      {ov.fixtureEnabled ? <span className="font-normal opacity-80">sensor fixtures are SIMULATED</span> : null}
    </div>
  )
}
