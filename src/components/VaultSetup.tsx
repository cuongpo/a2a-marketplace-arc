import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { agentBudgetVaultAbi } from '@/shared/abis'
import { parseUsdc } from '@/onchain-money'
import { usdc, type Overview } from '@/lib/api'
import { ErrorBox, TxLink } from './ui'

/** Human operator setup from your OWN wallet: deposit once, authorise the buyer agent under caps. Testnet only. */
export function VaultSetup({ ov }: { ov: Overview | null }) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash })
  const [amount, setAmount] = useState('2')
  const [localErr, setLocalErr] = useState<string | null>(null)

  const vault = ov?.contracts?.vault as Address | undefined
  const escrow = ov?.contracts?.escrow as Address | undefined
  const usdcAddr = ov?.usdc as Address | undefined
  const buyer = (ov?.buyerAgent ?? undefined) as Address | undefined
  const enabled = !!ov && ov.network === 'testnet' && !!vault && !!usdcAddr && !!address
  const common = { chainId: arcTestnet.id, query: { enabled, refetchInterval: 4000 } }
  const avail = useReadContract({ address: vault, abi: agentBudgetVaultAbi, functionName: 'availableOf', args: address ? [address] : undefined, ...common })
  const pol = useReadContract({ address: vault, abi: agentBudgetVaultAbi, functionName: 'policyOf', args: address ? [address] : undefined, ...common })
  const bal = useReadContract({ address: usdcAddr, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, ...common })

  if (ov && ov.network !== 'testnet') {
    return <section className="card p-4 text-sm text-[var(--muted)]">Mainnet is operated from your own wallet outside Arc Studio. See docs/MAINNET_RUNBOOK.md.</section>
  }

  async function act(fn: () => Promise<unknown>) {
    setLocalErr(null)
    reset()
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed'
      if (!/rejected|denied/i.test(msg)) setLocalErr(msg.split('\n')[0].slice(0, 200))
    }
  }
  const wrongChain = isConnected && chainId !== arcTestnet.id
  const policy = pol.data as { executor: string; paused: boolean } | undefined
  const authorised = policy && buyer && policy.executor.toLowerCase() === buyer.toLowerCase()

  return (
    <section className="card space-y-3 p-4 sm:p-5" aria-label="Set up your own operator vault">
      <div className="label">Your operator vault (own wallet)</div>
      <p className="text-xs text-[var(--muted)] text-pretty">
        One human setup: deposit USDC, authorise the buyer agent under per-mission, total and daily caps, allowlist the escrow. After that the agent funds missions on its own, only inside
        those limits. You can pause or reclaim unspent funds at any time.
      </p>
      <ConnectKitButton />
      {isConnected && ov && vault && escrow && usdcAddr && buyer ? (
        <>
          {wrongChain ? (
            <button type="button" className="btn btn-primary" disabled={switching} onClick={() => switchChain({ chainId: arcTestnet.id })}>
              Switch to Arc Testnet
            </button>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="label">Your wallet USDC</div>
                  <div className="num text-lg font-semibold">{bal.data !== undefined ? usdc(bal.data) : '...'}</div>
                </div>
                <div>
                  <div className="label">Your vault budget</div>
                  <div className="num text-lg font-semibold">{avail.data !== undefined ? usdc(avail.data) : '...'}</div>
                </div>
              </div>
              <div className="flex gap-2">
                <input aria-label="Deposit amount in USDC" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="num" />
                <button
                  type="button"
                  className="btn btn-primary shrink-0"
                  disabled={isPending}
                  onClick={() =>
                    void act(async () => {
                      const v = parseUsdc(amount)
                      await writeContractAsync({ address: usdcAddr, abi: erc20Abi, functionName: 'approve', args: [vault, v], chainId: arcTestnet.id })
                    })
                  }
                >
                  1. Allow
                </button>
                <button
                  type="button"
                  className="btn btn-primary shrink-0"
                  disabled={isPending}
                  onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'deposit', args: [parseUsdc(amount)], chainId: arcTestnet.id }))}
                >
                  2. Add to vault
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={isPending}
                  onClick={() =>
                    void act(async () => {
                      const exp = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400)
                      await writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setPolicy', args: [buyer, parseUsdc('1.5'), parseUsdc('10'), parseUsdc('5'), exp], chainId: arcTestnet.id })
                    })
                  }
                >
                  3. Authorise buyer agent (1.5 / 10 / 5 USDC caps)
                </button>
                <button type="button" className="btn btn-ghost" disabled={isPending} onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setEscrowAllowed', args: [escrow, true], chainId: arcTestnet.id }))}>
                  4. Allowlist escrow
                </button>
                <button type="button" className="btn btn-ghost" disabled={isPending || !policy} onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setPaused', args: [!policy?.paused], chainId: arcTestnet.id }))}>
                  {policy?.paused ? 'Resume agent' : 'Pause agent'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={isPending || !avail.data || (avail.data) === 0n || !address}
                  onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'withdrawAvailable', args: [avail.data as bigint, address as Address], chainId: arcTestnet.id }))}
                >
                  Reclaim unspent budget
                </button>
              </div>
              <p className="text-xs text-[var(--subtle)]">{authorised ? 'Buyer agent is authorised for your vault.' : 'Buyer agent is not yet authorised for your vault.'} To use it, tick the wallet option when you dispatch a mission.</p>
            </>
          )}
          {hash ? (
            <p className="text-xs">
              {receipt.isLoading ? 'Waiting for confirmation: ' : receipt.isSuccess ? 'Confirmed: ' : receipt.isError ? 'Failed: ' : ''}
              <TxLink chainId={arcTestnet.id} hash={hash} />
            </p>
          ) : null}
          {localErr || error ? <ErrorBox message={localErr ?? 'Transaction failed. Check the amount and your balance.'} /> : null}
        </>
      ) : null}
    </section>
  )
}
