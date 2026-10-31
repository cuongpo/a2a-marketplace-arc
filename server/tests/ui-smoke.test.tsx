import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarketplaceBoard, MarketplaceStage } from '@/components/MarketplaceBoard'
import { TradeFloor } from '@/components/TradeFloor'
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
    plotId: 'A2A-SLOT-B2',
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
  test('marketplace renders request slots and live states', () => {
    expect(renderToStaticMarkup(<MarketplaceStage cells={[]} mission={null} onOpenDetails={() => undefined} />)).toContain('Agent-to-agent')
    const cells: TileCell[] = [
      { tile: 'A1', col: 'A', row: 1, state: 'fog' },
      { tile: 'B2', col: 'B', row: 2, state: 'revealed', value: 444, simulated: true },
    ]
    const html = renderToStaticMarkup(<MarketplaceBoard cells={cells} selected="B2" onSelect={() => undefined} />)
    expect(html).toContain('AVAILABLE')
    expect(html).toContain('PAID')
    expect(html).toContain('SIM')
  })
  test('trading floor reflects chain settlement instead of inventing a payout', () => {
    const quoting = renderToStaticMarkup(<TradeFloor mission={pending} onOpenDetails={() => undefined} />)
    expect(quoting).toContain('0 verified bids')
    expect(quoting).toContain('No funds locked')
    expect(quoting).toContain('Buyer: obj.')
    expect(quoting).toContain('Provider: Waiting for bids.')
    expect(quoting).toContain('Escrow: No USDC locked.')
    expect(quoting).not.toContain('PROVIDER PAID')
    const settled = renderToStaticMarkup(<TradeFloor onOpenDetails={() => undefined} mission={{ ...pending, chain: {
      chainId: 5042002, escrow: '0x0000000000000000000000000000000000000002', onchainId: '9',
      provider: '0x0000000000000000000000000000000000000003', verifier: '0x0000000000000000000000000000000000000004',
      providerPrice: '400000', verifierFee: '50000', deadline: 2, createdBlock: '1', createdAtChain: 1,
    }, onchain: { status: 'Settled', outcome: 'ProviderPaid' } as never }} />)
    expect(settled).toContain('PROVIDER PAID')
    expect(settled).toContain('0.45 USDC settled')
    expect(settled).toContain('Escrow: 0.4 USDC paid to provider.')
    expect(renderToStaticMarkup(<TradeFloor onOpenDetails={() => undefined} mission={{ ...pending, onchain: { status: 'Settled', outcome: 'Split' } as never }} />)).toContain('SPLIT SETTLEMENT')
  })
  test('trading floor gives each signed provider a selectable bid and marks the actual winner', () => {
    const first: PMission['quotes'][number] = {
      quoteId: 'bid-one', provider: '0x0000000000000000000000000000000000000003', providerName: 'Alpha Data',
      priceUsdc: '400000', etaSec: 600, evidenceCapability: 'signed-device', validUntil: 100,
      tileId: `0x${'1'.repeat(64)}`, specHash: `0x${'1'.repeat(64)}`, signature: `0x${'a'.repeat(130)}`, simulated: false,
    }
    const second: PMission['quotes'][number] = { ...first, quoteId: 'bid-two', provider: '0x0000000000000000000000000000000000000004', providerName: 'Beta Sensor', priceUsdc: '550000', signature: `0x${'b'.repeat(130)}` }
    const scored = (quote: PMission['quotes'][number], score: number) => ({ quote, score, parts: { price: .5, capability: .5, reliability: .5, deadline: .5 } })
    const mission: PMission = { ...pending, quotes: [first, second], decision: { chosenQuoteId: second.quoteId, scored: [scored(first, .4), scored(second, .8)], rationale: 'Beta has stronger reliability', at: 1 } }
    const html = renderToStaticMarkup(<TradeFloor mission={mission} onOpenDetails={() => undefined} />)
    expect(html).toContain('2 signed bids · winner selected')
    expect(html).toContain('Alpha Data')
    expect(html).toContain('Beta Sensor')
    expect(html).toContain('0.55 USDC')
    expect(html).toContain('Selected winner')
    expect(html).toContain('Score 0.800')
    expect(html).toContain('Inspect signature')
    expect(html).not.toContain('ARC TRADE PROOF')
  })
  test('mode banner distinguishes unreachable backend and shows no data', () => {
    expect(renderToStaticMarkup(<ModeBanner ov={null} error="boom" />)).toContain('Backend unreachable')
  })
  test('empty states render without fabricated data', () => {
    expect(renderToStaticMarkup(<BidList m={pending} />)).toContain('Public auction is open')
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
