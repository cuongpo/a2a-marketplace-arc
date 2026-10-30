import { Landmark } from 'lucide-react'
import { usdc, type Overview } from '@/lib/api'
import { AddrLink, Badge, Empty, Stat } from './ui'

/** All figures are live reads of the ERC-20 view of USDC (6 decimals). Native and ERC-20 views are one balance and are never summed. */
export function WalletsPanel({ ov }: { ov: Overview | null }) {
  if (!ov) return <Empty title="Wallets">Loading...</Empty>
  const v = ov.vault
  return (
    <section className="card space-y-4 p-4 sm:p-5" aria-label="Agent wallets and operator vault">
      <div className="flex items-center gap-2">
        <Landmark size={16} aria-hidden />
        <div className="label">Operator vault (budget the buyer agent may spend)</div>
      </div>
      {v ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Available" value={usdc(v.available)} sub="USDC" />
            <Stat label="In escrow" value={usdc(v.committed)} sub="USDC" />
            <Stat label="Net spent" value={usdc(v.netSpent)} sub="USDC" />
          </div>
          <div className="inset p-3 text-xs text-[var(--muted)]">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-[var(--ink-2)]">Policy</span>
              {v.policy.paused ? <Badge tone="warn">paused</Badge> : <Badge tone="ok">active</Badge>}
            </div>
            per mission {usdc(v.policy.perMissionCap)} / total {usdc(v.policy.totalCap)} / daily {usdc(v.policy.dailyCap)} USDC. Executor:{' '}
            <AddrLink chainId={ov.chainId} address={v.policy.executor} />. Expires {new Date(Number(v.policy.expiry) * 1000).toLocaleDateString()}.
          </div>
        </>
      ) : (
        <Empty title="Vault not set up">
          No operator budget is visible yet. Run <span className="mono">bun run fq:setup</span> after funding the operator wallet, or use your own wallet below.
        </Empty>
      )}
      {ov.escrow ? (
        <div className="text-xs text-[var(--muted)]">
          Escrow holds <span className="num">{usdc(ov.escrow.usdcHeld)}</span> USDC against <span className="num">{usdc(ov.escrow.liabilities)}</span> USDC of liabilities
          {BigInt(ov.escrow.usdcHeld) >= BigInt(ov.escrow.liabilities) ? ' (fully covered).' : ' (UNDERCOVERED).'}
        </div>
      ) : null}
      <div>
        <div className="label mb-1">Agent wallets (testnet role keys, held by the backend)</div>
        <ul className="divide-y divide-white/10">
          {ov.wallets.map((w) => (
            <li key={w.role} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
              <span className="text-[var(--ink-2)]">{w.label}</span>
              <span className="flex items-center gap-3">
                <AddrLink chainId={ov.chainId} address={w.address} />
                <span className="num w-24 text-right">{usdc(w.usdc)} USDC</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {ov.contracts ? (
        <div>
          <div className="label mb-1">Deployed contracts</div>
          <ul className="space-y-1 text-xs">
            {Object.entries({ MissionEscrow: ov.contracts.escrow, AgentBudgetVault: ov.contracts.vault, EvidenceRegistry: ov.contracts.registry, Erc8004Adapter: ov.contracts.adapter }).map(([n, a]) =>
              a ? (
                <li key={n} className="flex justify-between gap-2">
                  <span className="text-[var(--ink-2)]">{n}</span>
                  <AddrLink chainId={ov.chainId} address={a} />
                </li>
              ) : null,
            )}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
