import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FieldGrid } from '@/components/FieldGrid'
import { ModeBanner } from '@/components/ModeBanner'
import { BidList } from '@/components/BidList'
import { EvidencePanel } from '@/components/EvidencePanel'
import { AgentTrack, lanesOf, stepOf } from '@/components/AgentTrack'
import type { PMission, TileCell } from '@/lib/api'

const pending: PMission = {
  id: 'abc12345',
  createdAt: 1,
  operator: '0x0000000000000000000000000000000000000001',
  scenario: 'custom',
  spec: {
    schema: 'fieldquest.mission/1',
    tile: 'B2',
    region: 'test',
    plotId: 'MKD-FIC-B2',
    objective: 'obj',
    metric: 'water_level',
    unit: 'mm',
    plausibleMin: 0,
    plausibleMax: 2500,
    maxReadingAgeSec: 1800,
    deadlineUnix: 2,
    challengeWindowSec: 45,
    budgetUsdc: '1000000',
    requireSecondSource: true,
    evidenceRequirements: [],
  },
  specHash: '0x' + '1'.repeat(64),
  stage: 'quoting',
  quotes: [],
  txs: [],
  audit: [],
  jobs: {},
  onchain: null,
  evidencePreview: null,
} as PMission

describe('UI render smoke (structure only, no live data)', () => {
  test('field grid renders fog placeholders and labelled tiles', () => {
    expect(renderToStaticMarkup(<FieldGrid cells={[]} selected={null} onSelect={() => undefined} />)).toContain('Mekong Delta')
    const cells: TileCell[] = [
      { tile: 'A1', col: 'A', row: 1, state: 'fog' },
      { tile: 'B2', col: 'B', row: 2, state: 'revealed', value: 444, simulated: true },
    ]
    const html = renderToStaticMarkup(<FieldGrid cells={cells} selected="B2" onSelect={() => undefined} />)
    expect(html).toContain('unsurveyed')
    expect(html).toContain('verified and paid')
    expect(html).toContain('(simulated)')
  })
  test('mode banner distinguishes unreachable backend and shows no data', () => {
    expect(renderToStaticMarkup(<ModeBanner ov={null} error="boom" />)).toContain('Backend unreachable')
  })
  test('empty states render without fabricated data', () => {
    expect(renderToStaticMarkup(<BidList m={pending} />)).toContain('requesting signed quotes')
    expect(renderToStaticMarkup(<EvidencePanel m={pending} />)).toContain('No evidence has been submitted')
    expect(renderToStaticMarkup(<AgentTrack m={pending} />)).toContain('Agent progress')
  })
  test('timeline step derives from real state only', () => {
    expect(stepOf(pending).note).toContain('collecting signed quotes')
    expect(stepOf({ ...pending, decision: {} as never, chain: undefined }).note).toContain('funding')
    const settled = { ...pending, decision: {} as never, chain: {} as never, onchain: { status: 'Settled', outcome: 'ProviderPaid' } as never }
    expect(stepOf(settled)).toEqual({ note: 'Settled: ProviderPaid', terminal: true, bad: false })
  })
  test('per-agent lanes only mark steps done when real state says so', () => {
    const lane = (m: PMission, id: string) => lanesOf(m).find((l) => l.id === id)!.steps.map((s) => s.done)
    expect(lane(pending, 'buyer')).toEqual([false, false, false])
    expect(lane(pending, 'provider')).toEqual([false, false, false])
    expect(lane(pending, 'keeper')).toEqual([false, false, false])
    const submitted = {
      ...pending,
      decision: {} as never,
      quotes: [{}] as never,
      chain: {} as never,
      onchain: { status: 'Submitted', outcome: 'None', decision: 'None', evidenceHash: '0x' + '11'.repeat(32) } as never,
    }
    expect(lane(submitted, 'buyer')).toEqual([true, true, true])
    expect(lane(submitted, 'provider')).toEqual([true, true, true])
    expect(lane(submitted, 'verifier')).toEqual([false, false, false])
    expect(lane({ ...submitted, onchain: { status: 'Accepted', decision: 'Accept', evidenceHash: '0x' + '11'.repeat(32) } as never }, 'verifier')).toEqual([true, true, true])
  })
})
