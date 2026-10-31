import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

// Isolated data dir BEFORE importing modules that read config at load time.
const dir = mkdtempSync(join(tmpdir(), 'fq-test-'))
process.env.FQ_DATA_DIR = dir
process.env.FQ_ENABLE_FIXTURE = '1'
process.env.FQ_NETWORK = 'testnet'
// Tests must not depend on the Arc Studio sandbox's private .env.
for (const name of [
  'FQ_OPERATOR_KEY',
  'FQ_BUYER_AGENT_KEY',
  'FQ_PROVIDER_KEY',
  'FQ_SENSOR_KEY',
  'FQ_PROVIDER2_KEY',
  'FQ_SENSOR2_KEY',
  'FQ_VERIFIER_KEY',
  'FQ_ARBITER_KEY',
]) process.env[name] = generatePrivateKey()

const { canonicalize, hashCanonical } = await import('../../src/shared/canonical')
const { account } = await import('../env')
const { runJob, missions, getEvidence, getPrivate, nonces, nonceKey } = await import('../store')
const { createMission, submitObservation, HttpError } = await import('../pipeline')
const { decide } = await import('../agents/buyer')
const { makeFixtureObservation, referenceGaugeMm } = await import('../fixture')
const { buildEvidence, recoverReadingSigner } = await import('../evidence')
const { registryDomain, readingTypes, tileIdOf } = await import('../../src/shared/typed')
const { CHAIN_ID, requireDeployment } = await import('../chain')

// Bun runs test files in one process; another file may still use the shared store.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

let counter = 0
const tiles = ['A', 'B', 'C', 'D', 'E'].flatMap((c) => [1, 2, 3, 4].map((r) => `${c}${r}`))
function fresh(scenario: 'accept' | 'reject' | 'custom' = 'accept', extra: Record<string, unknown> = {}) {
  return createMission({ tile: tiles[counter++], scenario, budgetUsdc: '1', ...extra })
}
function funded(m: ReturnType<typeof fresh>, provider: 'providerA' | 'providerB' = 'providerA') {
  const dep = requireDeployment()
  m.chain = {
    chainId: CHAIN_ID,
    escrow: dep.escrow,
    onchainId: '77',
    provider: account(provider).address,
    verifier: account('verifier').address,
    providerPrice: '400000',
    verifierFee: '50000',
    deadline: m.spec.deadlineUnix,
    createdBlock: '1',
    createdAtChain: Math.floor(Date.now() / 1000) - 30,
  }
  return m
}

describe('canonical JSON', () => {
  test('is key-order independent and deterministic', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 'x', c: null }] })).toBe(canonicalize({ a: [2, { c: null, d: 'x' }], b: 1 }))
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }))
  })
  test('rejects floats and unsafe integers', () => {
    expect(() => canonicalize({ v: 1.5 })).toThrow()
    expect(() => canonicalize({ v: 2 ** 60 })).toThrow()
  })
})

describe('mission creation guards', () => {
  test('rejects bad tile, absurd budget, bad deadline, bad operator', () => {
    expect(() => createMission({ tile: 'Z9' })).toThrow(HttpError)
    expect(() => createMission({ tile: 'F4', budgetUsdc: '500' })).toThrow(HttpError)
    expect(() => createMission({ tile: 'F4', budgetUsdc: '0.01' })).toThrow(HttpError)
    expect(() => createMission({ tile: 'F4', deadlineMinutes: 1 })).toThrow(HttpError)
    expect(() => createMission({ tile: 'F4', operator: 'nope' })).toThrow(HttpError)
  })
  test('one active mission per tile', () => {
    const m = createMission({ tile: 'F3', budgetUsdc: '1' })
    expect(missions.get(m.id)).toBeDefined()
    expect(() => createMission({ tile: 'F3', budgetUsdc: '1' })).toThrow(/active mission/)
  })
})

describe('buyer agent decision', () => {
  test('requests two signed quotes and picks provider A in the accept scenario', async () => {
    const m = fresh('accept')
    await decide(m)
    expect(m.quotes.length).toBe(2)
    const chosen = m.decision!.scored[0]
    expect(chosen.quote.provider).toBe(account('providerA').address)
    expect(m.decision!.rationale).toContain('Weights')
    expect(m.audit.some((a) => a.agent === 'buyer')).toBe(true)
  })
  test('picks provider B (cheaper, lower evidence capability) in the reject scenario', async () => {
    const m = fresh('reject')
    await decide(m)
    expect(m.decision!.scored[0].quote.provider).toBe(account('providerB').address)
  })
  test('excludes quotes over budget and blocks when none are eligible', async () => {
    const m = fresh('accept', { budgetUsdc: '0.2' })
    await decide(m)
    expect(m.stage).toBe('blocked')
    expect(m.decision).toBeUndefined()
  })
})

describe('simulated fixture + evidence', () => {
  test('valid fixture is signed by the sensor key, labelled simulated, payload hash binds', async () => {
    const m = funded(fresh('accept'))
    const obs = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    expect(obs.kind).toBe('simulated-fixture')
    expect(String(obs.operatorNote)).toContain('SIMULATED')
    expect(hashCanonical(obs.rawPayload)).toBe(obs.reading.payloadHash)
    const signer = await recoverTypedDataAddress({
      domain: registryDomain(CHAIN_ID, requireDeployment().registry),
      types: readingTypes,
      primaryType: 'Reading',
      message: {
        missionId: BigInt(obs.reading.missionId),
        tileId: obs.reading.tileId,
        observedAt: BigInt(obs.reading.observedAt),
        value: BigInt(obs.reading.value),
        unit: obs.reading.unit,
        nonce: BigInt(obs.reading.nonce),
        payloadHash: obs.reading.payloadHash,
      },
      signature: obs.signature,
    })
    expect(signer).toBe(account('sensorA').address)
    expect(obs.reading.tileId).toBe(tileIdOf(m.spec.tile))
    expect(Math.abs(Number(obs.reading.value) - referenceGaugeMm(m.spec.tile))).toBeLessThanOrEqual(12)
  })
  test('implausible and ambiguous variants differ as designed', async () => {
    const m = funded(fresh('reject'), 'providerB')
    const bad = await makeFixtureObservation(m, 'implausible', 'sensorB', m.chain!.createdAtChain)
    expect(Number(bad.reading.value)).toBeGreaterThan(m.spec.plausibleMax)
    const amb = await makeFixtureObservation(m, 'ambiguous', 'sensorB', m.chain!.createdAtChain)
    expect(Number(amb.reading.value)).toBeLessThanOrEqual(m.spec.plausibleMax)
    expect(Math.abs(Number(amb.reading.value) - referenceGaugeMm(m.spec.tile))).toBeGreaterThan(80)
  })
  test('evidence bundle is content-addressed, redacts private data, and stays hash-stable', async () => {
    const m = funded(fresh('accept'))
    const obs = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    const a = await buildEvidence(m, obs)
    const b = await buildEvidence(m, obs)
    expect(a.evidenceHash).toBe(hashCanonical(a.bundle))
    expect(b.evidenceHash).toBe(a.evidenceHash)
    const stored = getEvidence(a.evidenceHash)!
    expect(JSON.stringify(stored)).not.toContain('rawPayload')
    expect(JSON.stringify(stored)).not.toContain('FQ-SIM-GAUGE-A')
    expect(stored.provenance.simulated).toBe(true)
    expect(getPrivate(stored.privateDigest)).not.toBeNull()
    expect(await recoverReadingSigner(obs)).toBe(account('sensorA').address)
  })
})

describe('observation upload validation', () => {
  test('rejects malformed, wrong-mission and oversized payloads', async () => {
    const m = funded(fresh('accept'))
    await expect(submitObservation(m, {})).rejects.toThrow(HttpError)
    const good = await makeFixtureObservation(m, 'valid', 'sensorA', m.chain!.createdAtChain)
    await expect(submitObservation(m, { ...good, reading: { ...good.reading, missionId: '5' } })).rejects.toThrow(/different mission/)
    await expect(submitObservation(m, { ...good, signature: '0x12' })).rejects.toThrow(HttpError)
    await expect(submitObservation(m, { ...good, rawPayload: { x: 'y'.repeat(9000) } })).rejects.toThrow(HttpError)
    await submitObservation(m, good)
    expect(m.observation?.kind).toBe('field-operator-upload')
  })
})

describe('idempotent jobs', () => {
  test('a finished job never runs twice (restart cannot pay twice)', async () => {
    const m = fresh('accept')
    let runs = 0
    expect(await runJob(m, 'fund', () => Promise.resolve(void runs++))).toBe('done')
    expect(await runJob(m, 'fund', () => Promise.resolve(void runs++))).toBe('skipped')
    expect(runs).toBe(1)
  })
  test('failed jobs back off and stop after max attempts', async () => {
    const m = fresh('accept')
    let runs = 0
    const boom = () => {
      runs++
      return Promise.reject(new Error('rpc down'))
    }
    expect(await runJob(m, 'accept', boom)).toBe('failed')
    expect(await runJob(m, 'accept', boom)).toBe('skipped') // inside backoff window
    expect(runs).toBe(1)
    expect(m.jobs.accept.lastError).toContain('rpc down')
  })
  test('a job that is running is not started twice', async () => {
    const m = fresh('accept')
    let runs = 0
    const slow = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 30))
    }
    const [a, b] = await Promise.all([runJob(m, 'verdict', slow), runJob(m, 'verdict', slow)])
    expect([a, b].sort()).toEqual(['done', 'skipped'])
    expect(runs).toBe(1)
  })
  test('seen nonces are remembered across missions', () => {
    const k = nonceKey(account('sensorA').address, '123')
    nonces.set(k, 'm1')
    expect(nonces.get(k)).toBe('m1')
  })
})
