import { keccak256, toBytes, type Address, type Hex } from 'viem'

/** EIP-712 definitions shared by backend agents, scripts and the receipt verifier in the browser. */

export const USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000'
export const USDC_DECIMALS = 6

export const tileIdOf = (tile: string): Hex => keccak256(toBytes(`fieldquest:tile:${tile}`))
export const unitIdOf = (unit: string): Hex => keccak256(toBytes(unit))

export const registryDomain = (chainId: number, registry: Address) =>
  ({ name: 'FieldQuest EvidenceRegistry', version: '1', chainId, verifyingContract: registry }) as const

export const escrowDomain = (chainId: number, escrow: Address) =>
  ({ name: 'FieldQuest MissionEscrow', version: '1', chainId, verifyingContract: escrow }) as const

/** Off-chain only: provider quote signatures (no verifying contract). */
export const quoteDomain = (chainId: number) => ({ name: 'A2A Marketplace Quote', version: '1', chainId }) as const

export const readingTypes = {
  Reading: [
    { name: 'missionId', type: 'uint256' },
    { name: 'tileId', type: 'bytes32' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'value', type: 'int256' },
    { name: 'unit', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'payloadHash', type: 'bytes32' },
  ],
} as const

export const signerBindingTypes = {
  SignerBinding: [
    { name: 'provider', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
} as const

export const verdictTypes = {
  Verdict: [
    { name: 'missionId', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'decision', type: 'uint8' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export const quoteTypes = {
  Quote: [
    { name: 'provider', type: 'address' },
    { name: 'specHash', type: 'bytes32' },
    { name: 'tileId', type: 'bytes32' },
    { name: 'priceUsdc', type: 'uint256' },
    { name: 'etaSec', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'capability', type: 'string' },
  ],
} as const

export const DECISION = { none: 0, accept: 1, reject: 2, escalate: 3 } as const
export const STATUS_NAMES = [
  'None',
  'Funded',
  'Assigned',
  'Submitted',
  'Accepted',
  'Rejected',
  'Challenged',
  'Expired',
  'Settled',
] as const
export const OUTCOME_NAMES = ['None', 'ProviderPaid', 'BuyerRefunded', 'Split', 'Expired'] as const

// ---- Wallet-signed API authentication (EIP-712, off-chain only) ----

/** Domain binds the signature to this API and to the chain id. No verifying contract: nothing is ever sent onchain. */
export const apiAuthDomain = (chainId: number) => ({ name: 'A2A Marketplace API', version: '1', chainId }) as const

export const apiAuthTypes = {
  ApiRequest: [
    { name: 'statement', type: 'string' },
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'bodyHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const

export const API_AUTH_STATEMENT = 'Authorize this A2A Marketplace API request. Signing sends no transaction and moves no funds.'

export interface ApiChallenge {
  statement: string
  method: string
  path: string
  bodyHash: Hex
  nonce: Hex
  issuedAt: number
  expiresAt: number
  chainId: number
}
