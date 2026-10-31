import { useCallback } from 'react'
import { useAccount, useSignTypedData, useSwitchChain } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { hashRequestBody } from '@/shared/canonical'
import { apiAuthDomain, apiAuthTypes, type ApiChallenge } from '@/shared/typed'
import { api } from '@/lib/api'
import type { PMission, Overview } from '@/lib/api'

/**
 * Every write to the A2A Marketplace API is authorised by a wallet signature (EIP-712) over the exact method, path and body.
 * No bearer token or shared secret exists in this bundle. Reading the map, feed and receipts needs no wallet.
 */
export class WalletRequiredError extends Error {
  constructor() {
    super('Connect a wallet to do this. Browsing requests and public receipts needs no wallet.')
  }
}

export function useSignedPost() {
  const { address, isConnected, chainId } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const { switchChainAsync } = useSwitchChain()

  return useCallback(
    async <T,>(path: string, body: unknown = {}): Promise<T> => {
      if (!isConnected || !address) throw new WalletRequiredError()
      const bodyHash = hashRequestBody(body)
      const c = await api<ApiChallenge>('/auth/challenge', { method: 'POST', body: JSON.stringify({ method: 'POST', path, bodyHash }) })
      // Never sign something other than what we asked for.
      if (c.method !== 'POST' || c.path !== path || c.bodyHash !== bodyHash) throw new Error('The server returned a challenge for a different request. Nothing was signed.')
      if (c.chainId !== arcTestnet.id) throw new Error(`This build signs on Arc Testnet only (server asked for chain ${c.chainId}).`)
      if (chainId !== c.chainId) await switchChainAsync({ chainId: arcTestnet.id })
      const signature = await signTypedDataAsync({
        domain: apiAuthDomain(c.chainId),
        types: apiAuthTypes,
        primaryType: 'ApiRequest',
        message: { statement: c.statement, method: c.method, path: c.path, bodyHash: c.bodyHash, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt) },
      })
      return api<T>(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `A2AMarket nonce=${c.nonce}, signature=${signature}` },
      })
    },
    [address, isConnected, chainId, signTypedDataAsync, switchChainAsync],
  )
}

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Which roles the connected wallet holds for a given mission. Purely informational: the server decides. */
export function useRoles(m?: PMission, ov?: Overview | null) {
  const { address, isConnected } = useAccount()
  return {
    connected: isConnected,
    address,
    isOperator: eq(address, m?.operator),
    isProvider: eq(address, m?.chain?.provider),
    isArbiter: eq(address, ov?.arbiter),
  }
}
