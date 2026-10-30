import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { Compass } from 'lucide-react'
import { navigate, useApi, type Overview, type PMission, type TileCell } from '@/lib/api'
import { EventFeed } from '@/components/EventFeed'
import { FieldGrid } from '@/components/FieldGrid'
import { MissionComposer } from '@/components/MissionComposer'
import { MissionDetail } from '@/components/MissionDetail'
import { ModeBanner } from '@/components/ModeBanner'
import { ReceiptPage } from '@/components/ReceiptPage'
import { VaultSetup } from '@/components/VaultSetup'
import { WalletsPanel } from '@/components/WalletsPanel'
import { Empty } from '@/components/ui'

function usePath() {
  const [p, setP] = useState(window.location.pathname)
  useEffect(() => {
    const on = () => setP(window.location.pathname)
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return p
}

function MissionControl({ ov }: { ov: Overview | null }) {
  const tiles = useApi<TileCell[]>('/tiles', 3000)
  const missions = useApi<PMission[]>('/missions', 3000)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'mission' | 'vault'>('mission')

  const cells = tiles.data ?? []
  const cell = cells.find((c) => c.tile === selected)
  const mission = selected ? missions.data?.find((m) => m.spec.tile === selected) : undefined
  const refresh = useCallback(() => {
    void tiles.refresh()
    void missions.refresh()
  }, [tiles, missions])
  const canCompose = !!selected && (!mission || ['settled', 'expired', 'blocked', 'failed'].includes(mission.stage))
  const [composeFor, setComposeFor] = useState<string | null>(null)
  const composing = composeFor !== null && composeFor === selected
  const setComposing = (v: boolean) => setComposeFor(v ? selected : null)

  const panelRef = useRef<HTMLDivElement>(null)
  const pick = (t: string) => {
    setSelected(t)
    setTab('mission')
    // On narrow screens the detail panel sits below the board: bring it into view.
    if (window.matchMedia('(max-width: 1023px)').matches) setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
      <div className="space-y-4">{tiles.error && !tiles.data ? <Empty title="Field grid unavailable">{tiles.error}</Empty> : <FieldGrid cells={cells} selected={selected} onSelect={pick} />}</div>
      <div ref={panelRef} className="scroll-mt-3 space-y-4 lg:row-span-2">
        <div role="tablist" aria-label="Panels" className="flex gap-2">
          {(['mission', 'vault'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" className={`btn ${tab === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t)}>
              {t === 'mission' ? 'Mission' : 'Budget and wallets'}
            </button>
          ))}
        </div>
        {tab === 'vault' ? (
          <>
            <VaultSetup ov={ov} />
            <WalletsPanel ov={ov} />
          </>
        ) : !selected ? (
          <Empty title="Select a tile">
            Each tile is a potential information mission. Pick a fogged tile to set an objective, a USDC budget and a deadline. A buyer agent gathers competing signed bids, spends from your vault only
            within policy, and a verifier agent checks the evidence before anyone is paid. Everything here is readable without a wallet; actions ask you to sign.
          </Empty>
        ) : mission && !composing ? (
          <>
            <MissionDetail m={mission} ov={ov} onChange={refresh} />
            {canCompose ? (
              <button type="button" className="btn btn-ghost w-full" onClick={() => setComposing(true)}>
                Open a new mission on tile {selected}
              </button>
            ) : null}
          </>
        ) : cell ? (
          <MissionComposer
            tile={selected}
            ov={ov}
            onOpenVault={() => setTab('vault')}
            onCreated={() => {
              setComposing(false)
              refresh()
            }}
          />
        ) : (
          <Empty title="Loading tile">Waiting for the grid.</Empty>
        )}
      </div>
      <div className="space-y-4">
        <EventFeed ov={ov} />
      </div>
    </main>
  )
}

export default function App() {
  const path = usePath()
  const { data: ov, error } = useApi<Overview>('/overview', 6000)
  const receipt = path.match(/^\/receipt\/([\w-]+)\/?$/)

  return (
    <div className="min-h-dvh">
      <ModeBanner ov={ov} error={error} />
      <header className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <button type="button" className="flex items-center gap-2 text-left" onClick={() => navigate('/')} aria-label="FieldQuest mission control">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/5">
            <Compass size={20} aria-hidden />
          </span>
          <span>
            <span className="display block text-xl font-bold leading-none">FieldQuest</span>
            <span className="block text-[11px] text-[var(--subtle)]">verified field observations, paid in USDC on Arc</span>
          </span>
        </button>
        <ConnectKitButton showBalance={false} />
      </header>
      {receipt ? <ReceiptPage refId={receipt[1]} /> : <MissionControl ov={ov} />}
      <footer className="mx-auto max-w-7xl px-5 pb-2 pt-4 text-[11px] text-[var(--subtle)]">
        Unaudited research software. Testnet USDC has no value. Sensor fixtures are simulated and are not physical measurements.
      </footer>
    </div>
  )
}
