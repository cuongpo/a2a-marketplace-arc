import { useEffect, useRef, useState } from 'react'
import { CloudFog, MapPinned, ShieldCheck, ShieldX, Sparkles } from 'lucide-react'
import type { TileCell } from '@/lib/api'
import './farm.css'

const COLS = ['A', 'B', 'C', 'D', 'E', 'F']
const ROWS = [1, 2, 3, 4]
const X0 = 107
const Y0 = 151
const DX = 123
const DY = 111
const PW = 109
const PH = 97
const asset = (n: number) => `/assets/kenney-tiny-farm/tiles/tile_${String(n).padStart(4, '0')}.png`
const cropFor = [66, 42, 30, 18, 6, 54]

function stateLabel(c: TileCell) {
  switch (c.state) {
    case 'fog': return 'unsurveyed'
    case 'active': return c.value !== undefined ? 'reading revealed, settling' : 'mission in progress'
    case 'revealed': return 'verified and paid'
    case 'rejected': return 'evidence rejected or disputed, buyer refunded'
    case 'expired': return 'expired, refunded'
    case 'blocked': return 'blocked'
  }
}

function Sprite({ n, x, y, size = 36 }: { n: number; x: number; y: number; size?: number }) {
  return <image href={asset(n)} x={x} y={y} width={size} height={size} imageRendering="pixelated" aria-hidden="true" />
}

function Plot({ cell, x, y, selected, onSelect }: { cell: TileCell; x: number; y: number; selected: boolean; onSelect: (tile: string) => void }) {
  const variant = (cell.tile.charCodeAt(0) * 7 + Number(cell.tile.slice(1)) * 13) % cropFor.length
  const bad = ['rejected', 'expired', 'blocked'].includes(cell.state)
  const label = `Tile ${cell.tile}, ${stateLabel(cell)}${cell.value !== undefined ? `, reading ${cell.value} millimetres${cell.simulated ? ' (simulated)' : ''}` : ''}`
  const status = cell.state === 'revealed' ? 'PAID' : cell.state === 'rejected' ? 'REFUND' : cell.state === 'active' ? 'LIVE' : cell.state.toUpperCase()

  return (
    <g role="button" tabIndex={0} aria-label={label} aria-pressed={selected} className={`farm-plot farm-plot-${cell.state}${selected ? ' farm-plot-selected' : ''}`}
      onClick={() => onSelect(cell.tile)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(cell.tile) } }}>
      <title>{label}</title>
      <rect x={x + 4} y={y + 6} width={PW} height={PH} fill="#334b3b" opacity=".65" />
      <rect x={x} y={y} width={PW} height={PH} fill={variant % 2 ? '#79af6e' : '#8bb36f'} stroke={selected ? '#fff6c7' : '#54744c'} strokeWidth={selected ? 4 : 2} />
      <rect x={x + 6} y={y + 6} width={PW - 12} height={PH - 12} fill="url(#farm-soil)" opacity=".88" />
      {[0, 1, 2].flatMap((col) => [0, 1].map((row) => <Sprite key={`${col}-${row}`} n={cropFor[variant]} x={x + 11 + col * 30} y={y + 14 + row * 33} size={28} />))}
      {cell.state === 'fog' ? <>
        <rect x={x + 1} y={y + 1} width={PW - 2} height={PH - 2} fill="#142939" opacity=".81" />
        <g className="farm-fog" fill="#bdcbd0" opacity=".42"><rect x={x + 16} y={y + 37} width="41" height="10" /><rect x={x + 24} y={y + 31} width="25" height="8" /><rect x={x + 55} y={y + 55} width="34" height="8" /></g>
      </> : null}
      {bad ? <rect x={x + 1} y={y + 1} width={PW - 2} height={PH - 2} fill="url(#farm-refund)" opacity=".87" /> : null}
      {cell.state === 'active' ? <rect className="farm-pulse" x={x + 2} y={y + 2} width={PW - 4} height={PH - 4} fill="none" stroke="#ffe394" strokeWidth="4" /> : null}
      {cell.state === 'revealed' ? <rect x={x + 2} y={y + 2} width={PW - 4} height={PH - 4} fill="none" stroke="#dcf8a4" strokeWidth="4" /> : null}
      <rect x={x + 6} y={y + 6} width="32" height="20" fill="#18303a" opacity=".91" />
      <text x={x + 11} y={y + 21} className="farm-plot-id">{cell.tile}</text>
      {cell.value !== undefined ? <>
        <rect x={x + 7} y={y + PH - 39} width={PW - 14} height="31" fill="#142b2b" opacity=".94" />
        <text x={x + 13} y={y + PH - 16} className="farm-reading">{cell.value}<tspan className="farm-unit"> mm</tspan></text>
        {cell.simulated ? <text x={x + PW - 9} y={y + 20} textAnchor="end" className="farm-sim">SIM</text> : null}
      </> : <>
        <rect x={x + 7} y={y + PH - 27} width={bad ? 71 : 51} height="19" fill={bad ? '#713c3e' : '#172b34'} opacity=".96" />
        <text x={x + 13} y={y + PH - 13} className="farm-status">{status}</text>
      </>}
      {selected ? <><path d={`M${x + PW / 2 - 9} ${y - 13}h18l-9 11z`} fill="#ffdf82" stroke="#5d5037" strokeWidth="2" /><rect x={x - 5} y={y - 5} width={PW + 10} height={PH + 10} fill="none" stroke="#fff0a7" strokeWidth="2" strokeDasharray="6 4" /></> : null}
    </g>
  )
}

export function FieldGrid({ cells, selected, onSelect }: { cells: TileCell[]; selected: string | null; onSelect: (tile: string) => void }) {
  const [showScout, setShowScout] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)
  const by = new Map(cells.map((c) => [c.tile, c]))
  const count = (states: TileCell['state'][]) => cells.filter((c) => states.includes(c.state)).length
  const revealed = count(['revealed'])
  const live = count(['active'])
  const refunded = count(['rejected', 'expired'])
  const ci = selected ? COLS.indexOf(selected.charAt(0)) : -1
  const ri = selected ? Number(selected.slice(1)) - 1 : -1
  const scoutX = ci >= 0 ? X0 + ci * DX + PW / 2 : 473
  const scoutY = ri >= 0 ? Y0 + ri * DY + PH + 13 : 131

  useEffect(() => {
    const el = viewportRef.current
    if (!el || ci < 0 || el.scrollWidth <= el.clientWidth) return
    const worldX = (X0 + ci * DX + PW / 2) / 960
    el.scrollTo({ left: worldX * el.scrollWidth - el.clientWidth / 2, behavior: 'smooth' })
  }, [ci, selected])

  return (
    <section aria-label="Mekong Delta field grid (fictional plots)" className="farm-shell">
      <div className="farm-header">
        <div><div className="farm-eyebrow"><span className="farm-live-dot" /> FIELDQUEST / WORLD 01</div><h2 className="farm-title">Mekong Delta <span>field station</span></h2><p>Pick a plot, follow the agents, and reveal a reading when a mission pays.</p></div>
        <div className="farm-score" aria-label="Survey progress derived from mission states"><div><strong>{cells.length ? revealed : '–'}<small>/24</small></strong><span>PAID</span></div><div><strong>{cells.length ? live : '–'}</strong><span>LIVE</span></div><div><strong>{cells.length ? refunded : '–'}</strong><span>REFUNDS</span></div></div>
      </div>
      <div className="farm-toolbar"><span><MapPinned size={14} /> DELTA SECTOR / 6 × 4 PLOTS</span><span className="farm-swipe">SWIPE MAP ↔</span><button type="button" onClick={() => setShowScout((v) => !v)} aria-pressed={showScout}>{showScout ? 'HIDE SCOUT' : 'SHOW SCOUT'}</button></div>
      <div ref={viewportRef} className="farm-viewport" role="region" aria-label="Scrollable pixel field map; select a plot to inspect its mission" tabIndex={0}>
        <svg className="farm-canvas" viewBox="0 0 960 690" role="img" aria-label="Interactive pixel art field map with twenty-four selectable plots">
          <defs>
            <pattern id="farm-grass" width="32" height="32" patternUnits="userSpaceOnUse"><image href={asset(106)} width="32" height="32" imageRendering="pixelated" /></pattern>
            <pattern id="farm-soil" width="32" height="32" patternUnits="userSpaceOnUse"><image href={asset(0)} width="32" height="32" imageRendering="pixelated" /></pattern>
            <pattern id="farm-refund" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="16" height="16" fill="#613d3e" opacity=".7" /><rect width="5" height="16" fill="#e08a64" opacity=".8" /></pattern>
            <pattern id="farm-water" width="48" height="48" patternUnits="userSpaceOnUse"><rect width="48" height="48" fill="#5faab9" /><rect x="5" y="9" width="20" height="4" fill="#98d3cd" /><rect x="29" y="30" width="14" height="3" fill="#8bc9ca" /><rect x="18" y="39" width="5" height="3" fill="#418fa5" /></pattern>
          </defs>
          <rect width="960" height="690" fill="url(#farm-grass)" />
          <rect x="15" width="66" height="690" fill="url(#farm-water)" /><rect y="629" width="960" height="61" fill="url(#farm-water)" />
          <path d="M91 0V635M94 137H859M94 248H859M94 359H859M94 470H859M94 581H859" stroke="#a76545" strokeWidth="14" /><path d="M91 0V635M94 137H859M94 248H859M94 359H859M94 470H859M94 581H859" stroke="#d79861" strokeWidth="9" strokeDasharray="9 5" />
          <rect x="19" y="119" width="65" height="20" fill="#a57450" stroke="#704c3f" strokeWidth="3" /><rect x="19" y="572" width="65" height="20" fill="#a57450" stroke="#704c3f" strokeWidth="3" />
          {[3, 15, 27, 39, 3, 27].map((n, i) => <Sprite key={`tree-l-${i}`} n={n} x={i % 2 ? 4 : 831} y={155 + Math.floor(i / 2) * 157} size={53} />)}
          {[77, 78, 79, 80, 81, 83].map((n, i) => <Sprite key={`deco-${i}`} n={n} x={167 + i * 104} y={26 + (i % 2) * 12} size={35} />)}
          <Sprite n={72} x={255} y={52} size={39} /><Sprite n={73} x={293} y={52} size={39} /><Sprite n={96} x={845} y={494} size={40} /><Sprite n={97} x={872} y={494} size={40} />
          <g aria-hidden="true">{[90, 91, 92, 102, 103, 104, 114, 115, 116].map((n, i) => <Sprite key={`barn-${n}`} n={n} x={716 + (i % 3) * 35} y={4 + Math.floor(i / 3) * 35} size={35} />)}<text x="768" y="125" textAnchor="middle" className="farm-building-label">PROVIDER BARN</text></g>
          {ROWS.flatMap((r) => COLS.map((c, col) => { const tile = `${c}${r}`; const cell = by.get(tile); const x = X0 + col * DX; const y = Y0 + (r - 1) * DY; return cell ? <Plot key={tile} cell={cell} x={x} y={y} selected={selected === tile} onSelect={onSelect} /> : <g key={tile} aria-hidden="true"><rect x={x} y={y} width={PW} height={PH} fill="#243a3f" opacity=".88" /><text x={x + 10} y={y + 21} className="farm-plot-id">{tile}</text><text x={x + 10} y={y + PH - 13} className="farm-status">SYNC</text></g> }))}
          <Sprite n={109} x={367} y={93} size={43} /><text x="390" y="86" textAnchor="middle" className="farm-agent-label">BUYER</text>
          <Sprite n={108} x={569} y={93} size={43} /><text x="591" y="86" textAnchor="middle" className="farm-agent-label">VERIFIER</text>
          {showScout ? <g className="farm-scout" style={{ transform: `translate(${scoutX}px, ${scoutY}px)` }} aria-hidden="true"><image href={asset(109)} x="-22" y="-38" width="44" height="44" imageRendering="pixelated" /><text y="-45" textAnchor="middle" className="farm-agent-label">{selected ?? 'SCOUT'}</text></g> : null}
          <g aria-hidden="true"><rect x="110" y="605" width="219" height="49" fill="#223c39" stroke="#f2d188" strokeWidth="3" /><text x="123" y="625" className="farm-sign-title">FIELDQUEST</text><text x="123" y="643" className="farm-sign-sub">AGENT COMMERCE / ARC</text></g>
        </svg>
      </div>
      <div className="farm-footer"><div className="farm-legend"><span><CloudFog size={14} /> Fog</span><span><Sparkles size={14} /> Live</span><span><ShieldCheck size={14} /> Paid</span><span><ShieldX size={14} /> Refunded</span></div><p>Pixel terrain is decorative. Plot states and readings come from missions. SIM means simulated sensor input. Art: Kenney Tiny Farm (CC0).</p></div>
    </section>
  )
}
