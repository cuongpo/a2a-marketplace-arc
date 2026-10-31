import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { Network } from 'lucide-react'
import { navigate, useApi, type Overview, type PMission, type TileCell } from '@/lib/api'
import { EventFeed } from '@/components/EventFeed'
import { MarketplaceBoard, MarketplaceStage } from '@/components/MarketplaceBoard'
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
  const [pickedTile, setPickedTile] = useState<string | null>(null)
  const [tab, setTab] = useState<'mission' | 'vault'>('mission')
  const selected = pickedTile ?? ([...(missions.data ?? [])].sort((a, b) => b.createdAt - a.createdAt)[0]?.spec.tile || null)

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
    setPickedTile(t)
    setTab('mission')
    // First show the visual trade for existing work; new slots go straight to the composer.
    if (window.matchMedia('(max-width: 1023px)').matches) setTimeout(() => {
      const target = missions.data?.some((m) => m.spec.tile === t) ? document.querySelector('.trade-floor') : panelRef.current
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  return (
    <main className="mx-auto w-full max-w-[1600px] px-3 py-4 sm:px-5">
      {tiles.error && !tiles.data ? <Empty title="Marketplace unavailable">{tiles.error}</Empty> : <MarketplaceStage cells={cells} mission={mission ?? null} onOpenDetails={() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(350px,1fr)] lg:items-start">
        <div className="min-w-0 space-y-4">
          {tiles.error && !tiles.data ? null : <MarketplaceBoard cells={cells} selected={selected} onSelect={pick} />}
          <div className="hidden lg:block"><EventFeed ov={ov} /></div>
        </div>
        <div ref={panelRef} className="min-w-0 scroll-mt-3 space-y-4">
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
          <Empty title="Select a request slot">
            Pick an available slot to set an objective, a USDC budget and a deadline. Independent provider agents can submit signed bids. The buyer agent spends from your vault only
            within policy, and a verifier agent checks the evidence before anyone is paid. Everything here is readable without a wallet; actions ask you to sign.
          </Empty>
        ) : mission && !composing ? (
          <>
            <MissionDetail m={mission} ov={ov} onChange={refresh} />
            {canCompose ? (
              <button type="button" className="btn btn-ghost w-full" onClick={() => setComposing(true)}>
                Open a new request in slot {selected}
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
          <Empty title="Loading request">Waiting for the exchange.</Empty>
        )}
        <div className="lg:hidden"><EventFeed ov={ov} /></div>
        </div>
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
      <header className="market-app-header mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-5">
        <button type="button" className="flex items-center gap-2 text-left" onClick={() => navigate('/')} aria-label="A2A Marketplace home">
          <span className="market-brand-icon flex h-10 w-10 items-center justify-center" aria-hidden="true"><Network size={23} /></span>
          <span>
            <span className="market-brand-name block text-xl font-bold leading-none">A2A Marketplace</span>
            <span className="block text-[11px] text-[var(--subtle)]">agents hire agents · verified work · USDC on Arc</span>
          </span>
        </button>
        <ConnectKitButton showBalance={false} />
      </header>
      {receipt ? <ReceiptPage refId={receipt[1]} /> : <MissionControl ov={ov} />}
      <footer className="mx-auto max-w-7xl px-5 pb-2 pt-4 text-[11px] text-[var(--subtle)]">
        Unaudited research software. Testnet USDC has no value. Demo fixtures are simulated and are not independent measurements.
      </footer>
    </div>
  )
}
