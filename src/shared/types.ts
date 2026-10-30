import type { Address, Hex } from 'viem'

export type NetworkMode = 'testnet' | 'mainnet'

/** Mission objective, hashed (canonical JSON) into the escrow as objectiveHash. */
export interface MissionSpec {
  schema: 'fieldquest.mission/1'
  tile: string // e.g. "B2"
  region: string
  plotId: string // fictional unless real rights/consent are supplied
  objective: string
  metric: 'water_level'
  unit: 'mm'
  plausibleMin: number // inclusive, in unit
  plausibleMax: number // inclusive, in unit
  maxReadingAgeSec: number
  deadlineUnix: number // absolute unix seconds
  challengeWindowSec: number
  budgetUsdc: string // base units (6 decimals) decimal string; provider price + verifier fee ceiling
  requireSecondSource: boolean
  evidenceRequirements: string[]
}

export interface SignedQuote {
  quoteId: string
  provider: Address
  providerName: string
  priceUsdc: string // base units, 6 decimals
  etaSec: number
  evidenceCapability: 'signed-device' | 'signed-device+photo' | 'field-operator'
  validUntil: number
  tileId: Hex
  specHash: Hex
  signature: Hex // EIP-712 Quote signed by provider
  simulated: boolean
}

export interface ScoredQuote {
  quote: SignedQuote
  score: number
  parts: { price: number; capability: number; reliability: number; deadline: number }
  excluded?: string
}

export type ObservationKind = 'simulated-fixture' | 'field-operator-upload' | 'device-adapter'

export interface SignedReadingInput {
  reading: {
    missionId: string
    tileId: Hex
    observedAt: number
    value: string // int256 decimal
    unit: Hex
    nonce: string
    payloadHash: Hex
  }
  signature: Hex
  rawPayload: Record<string, unknown> // device payload; hashed to payloadHash
  kind: ObservationKind
  deviceSerial?: string
  operatorNote?: string
  photoSha256?: Hex // advisory only, never proof of date/location
}

/** Public part of the evidence bundle. The private part is kept server-side and committed by digest. */
export interface EvidenceBundle {
  schema: 'fieldquest.evidence/1'
  missionRef: { chainId: number; escrow: Address; missionId: string }
  tile: string
  plotId: string
  provenance: { kind: ObservationKind; label: string; simulated: boolean; deviceSerialMasked?: string }
  reading: SignedReadingInput['reading']
  signature: Hex
  signer: Address
  provider: Address
  photo?: { sha256: Hex; advisory: true; note: string }
  privateDigest: Hex // keccak256(canonical(private)) — private body is not published
  createdAt: number
}

export interface VerdictRecord {
  decision: 'accept' | 'reject' | 'escalate'
  reasons: { code: string; ok: boolean; detail: string }[]
  reasonHash: Hex
  nonce: string
  expiry: number
  signature: Hex
  verifier: Address
}

export type StageId =
  | 'quoting'
  | 'decided'
  | 'funding'
  | 'funded'
  | 'assigned'
  | 'awaiting_observation'
  | 'evidence_submitted'
  | 'verdict'
  | 'challenge_window'
  | 'challenged'
  | 'settled'
  | 'expired'
  | 'blocked'
  | 'failed'

export interface TxRecord {
  label: string
  hash: Hex
  from: Address
  status: 'pending' | 'success' | 'reverted'
  blockNumber?: string
  at: number
}

export interface AuditEntry {
  at: number
  agent: 'operator' | 'buyer' | 'provider' | 'verifier' | 'keeper' | 'arbiter' | 'system'
  level: 'info' | 'warn' | 'error'
  message: string
  data?: Record<string, unknown>
}

export interface MissionRecord {
  id: string // local id
  createdAt: number
  operator: Address
  scenario: 'accept' | 'reject' | 'dispute' | 'custom'
  spec: MissionSpec
  specHash: Hex
  stage: StageId
  stageNote?: string
  quotes: SignedQuote[]
  decision?: {
    chosenQuoteId: string
    scored: ScoredQuote[]
    rationale: string
    at: number
  }
  chain?: {
    chainId: number
    escrow: Address
    onchainId: string
    provider: Address
    verifier: Address
    providerPrice: string
    verifierFee: string
    deadline: number
    createdBlock: string
    createdAtChain: number
  }
  /** When true the provider agent feeds the SIMULATED fixture automatically (used by demo scripts). */
  autoFixture?: boolean
  observation?: SignedReadingInput
  evidenceHash?: Hex
  verdict?: VerdictRecord
  txs: TxRecord[]
  audit: AuditEntry[]
  jobs: Record<string, JobRecord>
}

export interface JobRecord {
  key: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  txHash?: Hex
  lastError?: string
  updatedAt: number
}
