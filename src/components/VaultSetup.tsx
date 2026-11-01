import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { agentBudgetVaultAbi } from '@/shared/abis'
import { parseUsdc } from '@/onchain-money'
import { usdc, type Overview } from '@/lib/api'
import { ErrorBox, TxLink } from './ui'

/** Human operator setup from their own wallet, on the chain reported by the backend. */
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
  const targetChainId = ov?.chainId
  const enabled = !!ov && (targetChainId === 5042 || targetChainId === 5042002) && !!vault && !!usdcAddr && !!address
  const common = { chainId: targetChainId, query: { enabled, refetchInterval: 4000 } }
  const avail = useReadContract({ address: vault, abi: agentBudgetVaultAbi, functionName: 'availableOf', args: address ? [address] : undefined, ...common })
  const pol = useReadContract({ address: vault, abi: agentBudgetVaultAbi, functionName: 'policyOf', args: address ? [address] : undefined, ...common })
  const bal = useReadContract({ address: usdcAddr, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, ...common })

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
  const wrongChain = isConnected && !!targetChainId && chainId !== targetChainId
  const caps = ov?.network === 'mainnet' ? ['0.50', '2', '1'] as const : ['1.5', '10', '5'] as const
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
            <button type="button" className="btn btn-primary" disabled={switching || !targetChainId} onClick={() => targetChainId && switchChain({ chainId: targetChainId })}>
              Switch to Arc {ov.network === 'mainnet' ? 'Mainnet' : 'Testnet'}
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
                      await writeContractAsync({ address: usdcAddr, abi: erc20Abi, functionName: 'approve', args: [vault, v], chainId: targetChainId })
                    })
                  }
                >
                  1. Allow
                </button>
                <button
                  type="button"
                  className="btn btn-primary shrink-0"
                  disabled={isPending}
                  onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'deposit', args: [parseUsdc(amount)], chainId: targetChainId }))}
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
                      await writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setPolicy', args: [buyer, parseUsdc(caps[0]), parseUsdc(caps[1]), parseUsdc(caps[2]), exp], chainId: targetChainId })
                    })
                  }
                >
                  3. Authorise buyer agent ({caps.join(' / ')} USDC caps)
                </button>
                <button type="button" className="btn btn-ghost" disabled={isPending} onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setEscrowAllowed', args: [escrow, true], chainId: targetChainId }))}>
                  4. Allowlist escrow
                </button>
                <button type="button" className="btn btn-ghost" disabled={isPending || !policy} onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'setPaused', args: [!policy?.paused], chainId: targetChainId }))}>
                  {policy?.paused ? 'Resume agent' : 'Pause agent'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={isPending || !avail.data || (avail.data) === 0n || !address}
                  onClick={() => void act(() => writeContractAsync({ address: vault, abi: agentBudgetVaultAbi, functionName: 'withdrawAvailable', args: [avail.data as bigint, address as Address], chainId: targetChainId }))}
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
              <TxLink chainId={targetChainId ?? 5042002} hash={hash} />
            </p>
          ) : null}
          {localErr || error ? <ErrorBox message={localErr ?? 'Transaction failed. Check the amount and your balance.'} /> : null}
        </>
      ) : null}
    </section>
  )
}
