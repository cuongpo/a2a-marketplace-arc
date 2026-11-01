// External Provider Agent runner (Arc Testnet only). Run it with ONLY its own env file so it never sees the backend's keys:
//   bun --no-env-file --env-file=.env.provider run runner/provider-agent.ts
// See docs/EXTERNAL_PROVIDER.md and .env.provider.example. Keys are read from the environment and never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { requireChain } from '../src/onchain-facts'
import { parseUsdc } from '../src/onchain-money'
import { erc8004AdapterAbi, evidenceRegistryAbi, missionEscrowAbi } from '../src/shared/abis'
import { hashRequestBody, hashText } from '../src/shared/canonical'
import { CAPABILITIES, registrationDataUri } from '../src/shared/network'
import { apiAuthDomain, apiAuthTypes, quoteDomain, quoteTypes, readingTypes, registryDomain, signerBindingTypes, tileIdOf, type ApiChallenge } from '../src/shared/typed'
import testnetDeployment from '../src/deployments/arc-testnet.json'
import mainnetDeployment from '../src/deployments/arc-mainnet.json'
import { emptyState, tick, setup, type FeedValue, type RunnerConfig, type RunnerIo, type RunnerState } from './core'
import type { SignedReadingInput } from '../src/shared/types'

const IS_MAINNET = (process.env.RUNNER_NETWORK ?? process.env.FQ_NETWORK) === 'mainnet'
const CHAIN_ID = IS_MAINNET ? 5042 : 5042002
if (IS_MAINNET && process.env.RUNNER_MAINNET_ACK !== 'audited-and-funded')
  throw new Error('Mainnet provider runner is locked until the contracts are audited, deployed and explicitly enabled with RUNNER_MAINNET_ACK')
if (IS_MAINNET && process.env.SIMULATED === '1') throw new Error('SIMULATED feed is forbidden on mainnet')
const env = (k: string, d?: string) => process.env[k] ?? d
const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`missing ${k} (see .env.provider.example)`)
  return v
}
const keyOf = (k: string) => {
  const raw = need(k)
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${k} must be a 0x-prefixed 32-byte hex private key`)
  return privateKeyToAccount(raw as Hex)
}

const wallet = keyOf('PROVIDER_AGENT_KEY')
const device = keyOf('DEVICE_KEY')
if (wallet.address.toLowerCase() === device.address.toLowerCase()) throw new Error('DEVICE_KEY must be different from the wallet key')
const API = (env('A2A_API', 'http://127.0.0.1:3001') as string).replace(/\/$/, '')
const dep = (IS_MAINNET ? mainnetDeployment : testnetDeployment) as { registry: Address; escrow: Address; adapter: Address; identityRegistry: Address }
if (!([dep.registry, dep.escrow, dep.adapter, dep.identityRegistry].every((a) => /^0x[0-9a-fA-F]{40}$/.test(a))))
  throw new Error('the selected Arc deployment is incomplete; no provider transaction will be sent')
const facts = requireChain(CHAIN_ID)
const chain = defineChain({ id: CHAIN_ID, name: facts.name, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: facts.nativeCurrency.decimals }, rpcUrls: { default: { http: [facts.rpcUrls[0]] } } })
const transport = () => http(undefined, { retryCount: 6, retryDelay: 700, timeout: 20_000 })
const pub = createPublicClient({ chain, transport: transport() })
const wc = createWalletClient({ account: wallet, chain, transport: transport() })
const identityAbi = parseAbi(['function register(string agentURI) returns (uint256 agentId)', 'function ownerOf(uint256 agentId) view returns (address)', 'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'])

const usdcDec = (k: string, d: string) => parseUsdc(env(k, d) as string)
const feedFile = env('FEED_FILE')
const cfg: RunnerConfig = {
  displayName: env('PROVIDER_NAME', 'External Data Agent') as string,
  capability: (CAPABILITIES.find((c) => c === env('CAPABILITY', 'field-operator')) ?? 'field-operator'),
  minPriceUsdc: usdcDec('MIN_PRICE_USDC', '0.10'),
  maxPriceUsdc: usdcDec('MAX_PRICE_USDC', '0.60'),
  priceUsdc: usdcDec('QUOTE_PRICE_USDC', '0.30'),
  maxEtaSec: Number(env('MAX_ETA_SEC', '1800')),
  etaSec: Number(env('ETA_SEC', '600')),
  cardUrl: env('CARD_URL') || undefined,
  agentId: env('AGENT_ID') || undefined,
  bidOnUninvited: env('BID_ON_UNINVITED', '0') === '1',
  feedMode: feedFile ? 'file' : env('SIMULATED') === '1' ? 'simulated' : 'none',
}
if (cfg.feedMode === 'none') console.log('[runner] no FEED_FILE and SIMULATED!=1: the runner will bid and accept, then pause at the observation step until you provide a feed value.')

const statePath = env('RUNNER_STATE_FILE', `runner-state-${wallet.address.slice(2, 8).toLowerCase()}.json`) as string
let state: RunnerState = emptyState()
if (existsSync(statePath)) state = { ...emptyState(), ...(JSON.parse(readFileSync(statePath, 'utf8')) as Partial<RunnerState>) }
const saveState = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })

async function signedPost<T>(path: string, body: unknown): Promise<T> {
  const bodyHash = hashRequestBody(body)
  const ch = await fetch(`${API}/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'POST', path, bodyHash }) })
  const c = (await ch.json()) as ApiChallenge & { error?: string }
  if (!ch.ok) throw new Error(`challenge for ${path}: ${c.error ?? ch.status}`)
  if (c.method !== 'POST' || c.path !== path || c.bodyHash !== bodyHash || c.chainId !== CHAIN_ID) throw new Error('server returned a challenge for a different request')
  const signature = await wallet.signTypedData({
    domain: apiAuthDomain(c.chainId), types: apiAuthTypes, primaryType: 'ApiRequest',
    message: { statement: c.statement, method: c.method, path: c.path, bodyHash: c.bodyHash, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt) },
  })
  const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `A2AMarket nonce=${c.nonce}, signature=${signature}` }, body: JSON.stringify(body) })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `${path} failed (${res.status})`)
  return json
}

async function sendTx(req: Parameters<typeof pub.simulateContract>[0], onHash: (h: Hex) => void): Promise<Hex> {
  const { request } = await pub.simulateContract({ ...req, account: wallet } as never)
  const hash = await wc.writeContract(request as never)
  onHash(hash)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (r.status !== 'success') throw new Error(`transaction reverted: ${hash}`)
  return hash
}

function readingMessage(r: SignedReadingInput['reading']) {
  return { missionId: BigInt(r.missionId), tileId: r.tileId, observedAt: BigInt(r.observedAt), value: BigInt(r.value), unit: r.unit, nonce: BigInt(r.nonce), payloadHash: r.payloadHash }
}

function feed(tile: string): Promise<FeedValue | null> {
  if (cfg.feedMode === 'file') {
    // Explicit operator-supplied number: labelled field-operator-upload. This runner never claims a physical sensor.
    const data = existsSync(feedFile as string) ? (JSON.parse(readFileSync(feedFile as string, 'utf8')) as Record<string, { valueMm?: number; note?: string }>) : {}
    const item = data[tile]
    if (!item || !Number.isInteger(item.valueMm)) return Promise.resolve(null)
    return Promise.resolve({ valueMm: item.valueMm as number, kind: 'field-operator-upload', rawPayload: { source: 'operator-supplied feed file', tile, valueMm: item.valueMm, note: item.note ?? 'entered by the provider operator; not a verified physical measurement' } })
  }
  if (cfg.feedMode === 'simulated') {
    // Testnet-only SIMULATED value, labelled as such all the way into the evidence and receipt.
    const v = 380 + (parseInt(hashText(`sim:${tile}`).slice(2, 6), 16) % 120)
    return Promise.resolve({ valueMm: v, kind: 'simulated-fixture', rawPayload: { fixture: true, label: 'SIMULATED provider feed (testnet protocol test, not a physical measurement)', tile, valueMm: v } })
  }
  return Promise.resolve(null)
}

const io: RunnerIo = {
  me: wallet.address,
  device: device.address,
  nowSec: () => Math.floor(Date.now() / 1000),
  log: (m) => console.log(`[runner ${new Date().toISOString().slice(11, 19)}] ${m}`),
  state,
  saveState,
  api: {
    get: async <T>(path: string) => {
      const r = await fetch(API + path)
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`GET ${path} failed (${r.status})`)
      return (await r.json()) as T
    },
    post: signedPost,
  },
  chain: {
    adapterIdentity: async () => {
      const [agentId, bound] = await pub.readContract({ address: dep.adapter, abi: erc8004AdapterAbi, functionName: 'identityOf', args: [wallet.address] })
      return { agentId, bound }
    },
    ownerOf: (id) => pub.readContract({ address: dep.identityRegistry, abi: identityAbi, functionName: 'ownerOf', args: [id] }),
    registerIdentity: async (uri, onHash) => {
      const hash = await sendTx({ address: dep.identityRegistry, abi: identityAbi, functionName: 'register', args: [uri] }, onHash)
      return { hash, agentId: await io.chain.registeredId(hash) }
    },
    registeredId: async (hash) => {
      const receipt = await pub.getTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`identity registration reverted: ${hash}`)
      for (const l of receipt.logs) {
        if (l.address.toLowerCase() !== dep.identityRegistry.toLowerCase()) continue
        try {
          const ev = decodeEventLog({ abi: identityAbi, data: l.data, topics: l.topics })
          if (ev.eventName === 'Registered' && ev.args.owner.toLowerCase() === wallet.address.toLowerCase()) return ev.args.agentId
        } catch {
          /* not the Registered event */
        }
      }
      throw new Error('Registered event not found in the identity registration receipt')
    },
    bind: (agentId, onHash) => sendTx({ address: dep.adapter, abi: erc8004AdapterAbi, functionName: 'bindAgent', args: [agentId] }, onHash),
    signerInfo: async (d) => {
      const [provider, active] = await pub.readContract({ address: dep.registry, abi: evidenceRegistryAbi, functionName: 'signerInfo', args: [d] })
      return { provider, active }
    },
    registerSigner: async (onHash) => {
      const metadataHash = hashText(`a2a-runner:${cfg.displayName}`)
      const sig = await device.signTypedData({ domain: registryDomain(CHAIN_ID, dep.registry), types: signerBindingTypes, primaryType: 'SignerBinding', message: { provider: wallet.address, signer: device.address, metadataHash } })
      return sendTx({ address: dep.registry, abi: evidenceRegistryAbi, functionName: 'registerSigner', args: [device.address, metadataHash, sig] }, onHash)
    },
    mission: async (id) => {
      const m = await pub.readContract({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'getMission', args: [id] })
      return { status: m.status, provider: m.provider, createdAt: m.createdAt, deadline: m.deadline, tileId: m.tileId, unit: m.unit, maxReadingAge: m.maxReadingAge }
    },
    wait: async (hash) => {
      try {
        const r = await pub.getTransactionReceipt({ hash })
        return r.status === 'success' ? 'success' : 'reverted'
      } catch {
        return 'unknown'
      }
    },
    accept: (id, onHash) => sendTx({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'acceptAssignment', args: [id] }, onHash),
    submitEvidence: (id, evidenceHash, obs, onHash) =>
      sendTx({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'submitEvidence', args: [id, evidenceHash, readingMessage(obs.reading), obs.signature] }, onHash),
    credits: () => pub.readContract({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'credits', args: [wallet.address] }),
    withdraw: (onHash) => sendTx({ address: dep.escrow, abi: missionEscrowAbi, functionName: 'withdraw', args: [wallet.address] }, onHash),
    verifierFeeUsdc: () => 50_000n,
  },
  signQuote: (q) =>
    wallet.signTypedData({
      domain: quoteDomain(CHAIN_ID), types: quoteTypes, primaryType: 'Quote',
      message: { provider: wallet.address, specHash: q.specHash, tileId: q.tileId, priceUsdc: q.priceUsdc, etaSec: BigInt(q.etaSec), validUntil: BigInt(q.validUntil), capability: q.capability },
    }),
  signReading: (r) => device.signTypedData({ domain: registryDomain(CHAIN_ID, dep.registry), types: readingTypes, primaryType: 'Reading', message: readingMessage(r) }),
  tileIdOf,
  registrationUri: (agentId) => registrationDataUri({ name: cfg.displayName, capability: cfg.capability, chainId: CHAIN_ID, identityRegistry: dep.identityRegistry, agentId }),
  feed,
  nonce: () => BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('')).toString(),
}

console.log(`[runner] wallet ${wallet.address}  device ${device.address}  api ${API}  feed ${cfg.feedMode}`)
const agentId = await setup(io, cfg)
console.log(`[runner] ready as ERC-8004 agent #${agentId}; polling every ${env('POLL_SEC', '5')}s`)
let running = true
process.on('SIGINT', () => { running = false })
do {
  try {
    const notes = await tick(io, cfg)
    for (const n of notes) io.log(n)
  } catch (e) {
    io.log(`tick error (will retry; nothing is resent blindly): ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
  }
  if (env('ONCE') === '1') break
  await new Promise((r) => setTimeout(r, Number(env('POLL_SEC', '5')) * 1000))
} while (running)
