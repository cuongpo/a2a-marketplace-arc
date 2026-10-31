import { useEffect, useRef } from 'react'

type Phase = 'request' | 'quotes' | 'escrow' | 'delivery' | 'verdict' | 'settlement' | null
type Art = { room: HTMLImageElement; interiors: HTMLImageElement; idle: Record<string, HTMLImageElement>; run: Record<string, HTMLImageElement> }
type Point = { x: number; y: number }
type SceneState = { phase: Phase; bids: number; escrowed: boolean; evidence: boolean; settled: boolean; outcome: string | null }
type Motion = { positions: Record<string, Point>; phase: Phase; phaseStart: number; lastFrame: number; mobile: boolean | null }

const BASE = '/assets/modern-tiles/'
const PEOPLE = ['Adam', 'Amelia', 'Bob', 'Alex'] as const

function sprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, x: number, y: number, w = sw, h = sh) {
  ctx.drawImage(img, sx, sy, sw, sh, Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}

function furniture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, sx: number, sy: number, sw: number, sh: number, w = sw, h = sh) {
  sprite(ctx, img, sx, sy, sw, sh, x, y, w, h)
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#f8f1d8') {
  ctx.font = 'bold 8px monospace'
  const width = Math.ceil(ctx.measureText(text).width) + 10
  ctx.fillStyle = '#293142'
  ctx.fillRect(Math.round(x - width / 2), Math.round(y - 8), width, 12)
  ctx.strokeStyle = '#718f96'
  ctx.strokeRect(Math.round(x - width / 2) + .5, Math.round(y - 8) + .5, width - 1, 11)
  ctx.fillStyle = color
  ctx.fillText(text, Math.round(x - width / 2) + 5, Math.round(y))
}

function path(points: Point[], progress: number): Point {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y))
  let distance = Math.max(0, Math.min(1, progress)) * lengths.reduce((sum, length) => sum + length, 0)
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : distance / lengths[i]
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }
    }
    distance -= lengths[i]
  }
  return points[points.length - 1]
}

function route(from: Point, to: Point, aisle: number, elapsed: number): Point {
  // Four and a half seconds each way, with a pause at either station.
  const cycle = elapsed % 12
  const leg = cycle < 4.5 ? cycle / 4.5 : cycle < 6 ? 1 : cycle < 10.5 ? 1 - (cycle - 6) / 4.5 : 0
  const progress = leg * leg * (3 - 2 * leg)
  return path([from, { x: from.x, y: aisle }, { x: to.x, y: aisle }, to], progress)
}

function drawPerson(ctx: CanvasRenderingContext2D, art: Art, name: typeof PEOPLE[number], point: Point, busy: boolean, time: number, headingLeft = false) {
  ctx.fillStyle = '#34404666'
  ctx.beginPath()
  ctx.ellipse(Math.round(point.x), Math.round(point.y - 1), 13, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  const image = busy ? art.run[name] : art.idle[name]
  const frame = Math.floor(time * (busy ? 5 : 1.5)) % 6
  const width = 28
  const height = 56
  const x = Math.round(point.x - width / 2)
  const y = Math.round(point.y - height)
  if (headingLeft) {
    ctx.save()
    ctx.translate(x + width, 0)
    ctx.scale(-1, 1)
    sprite(ctx, image, frame * 16, 0, 16, 32, 0, y, width, height)
    ctx.restore()
  } else sprite(ctx, image, frame * 16, 0, 16, 32, x, y, width, height)
}

function room(ctx: CanvasRenderingContext2D, art: Art, width: number, height: number, mobile: boolean, state: SceneState, motion: Motion, time: number, elapsed: number, delta: number, reducedMotion: boolean) {
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = false
  const { room: tiles, interiors: props } = art
  const { phase, bids, escrowed, evidence, settled, outcome } = state
  // The actual LimeZu tiles form one continuous room. All furniture and people share this coordinate system.
  for (let x = 0; x < width; x += 16) {
    for (let y = 0; y < 64; y += 16) sprite(ctx, tiles, 64, y < 48 ? 144 + (y % 32) : 192, 16, 16, x, y)
    for (let y = 64; y < height; y += 16) sprite(ctx, tiles, 224, 176, 16, 16, x, y)
  }
  ctx.fillStyle = '#74665d'
  ctx.fillRect(0, 61, width, 4)
  ctx.fillStyle = '#3e4e56'
  ctx.fillRect(0, 64, width, 2)
  ctx.fillStyle = '#342d39'
  ctx.fillRect(0, height - 8, width, 8)
  ctx.fillRect(0, 0, 5, height)
  ctx.fillRect(width - 5, 0, 5, height)

  const point = mobile
    ? { buyer: { x: 74, y: 186 }, provider: { x: 237, y: 186 }, providerB: { x: 266, y: 214 }, escrow: { x: 78, y: 357 }, verifier: { x: 246, y: 357 }, aisle: 234 }
    : { buyer: { x: 104, y: 218 }, provider: { x: 270, y: 218 }, providerB: { x: 312, y: 240 }, escrow: { x: 418, y: 218 }, verifier: { x: 550, y: 218 }, aisle: 266 }

  // Wall fixtures, shelves, plants, desks, chairs and rugs are sampled directly from the free atlas.
  if (mobile) {
    furniture(ctx, props, 10, 9, 96, 0, 48, 48)
    furniture(ctx, props, 260, 8, 96, 0, 48, 48)
    furniture(ctx, props, 16, 75, 80, 224, 32, 64)
    furniture(ctx, props, 276, 75, 208, 704, 32, 48)
    furniture(ctx, props, 21, 128, 0, 576, 112, 32)
    furniture(ctx, props, 184, 127, 32, 608, 96, 48)
    furniture(ctx, props, 114, 216, 112, 240, 64, 48, 91, 67)
    furniture(ctx, props, 25, 289, 0, 704, 128, 64, 112, 56)
    furniture(ctx, props, 193, 295, 160, 640, 80, 32)
    furniture(ctx, props, 276, 293, 208, 704, 32, 48)
    furniture(ctx, props, 8, 331, 176, 1104, 80, 48, 48, 29)
    label(ctx, 'BUYER', 78, 91)
    label(ctx, 'PROVIDERS', 238, 91)
    label(ctx, 'USDC ESCROW', 81, 273)
    label(ctx, 'VERIFIER', 238, 273)
  } else {
    furniture(ctx, props, 10, 8, 96, 0, 48, 48)
    furniture(ctx, props, 576, 8, 96, 0, 48, 48)
    furniture(ctx, props, 16, 82, 80, 224, 32, 64)
    furniture(ctx, props, 578, 90, 208, 704, 32, 48)
    furniture(ctx, props, 65, 133, 0, 576, 112, 32)
    furniture(ctx, props, 227, 129, 32, 608, 96, 48)
    furniture(ctx, props, 347, 136, 0, 704, 128, 64, 112, 56)
    furniture(ctx, props, 498, 140, 160, 640, 80, 32)
    furniture(ctx, props, 23, 250, 176, 1104, 80, 48, 80, 43)
    furniture(ctx, props, 175, 216, 112, 240, 64, 48, 96, 72)
    furniture(ctx, props, 534, 249, 176, 1104, 80, 48, 80, 43)
    furniture(ctx, props, 467, 70, 176, 1104, 80, 48, 80, 43)
    label(ctx, 'BUYER DESK', 106, 91)
    label(ctx, 'PROVIDER MARKET', 268, 91)
    label(ctx, 'USDC ESCROW', 417, 91)
    label(ctx, 'VERIFICATION', 547, 91)
  }

  // Small in-world status lamps are tied to recorded state, including replay state.
  const lamps: { x: number; on: boolean; color: string }[] = mobile
    ? [{ x: 78, on: true, color: '#88e6c7' }, { x: 238, on: bids > 0, color: '#f9cf8f' }, { x: 80, on: escrowed, color: '#efbe72' }, { x: 238, on: evidence, color: '#c9b9fa' }]
    : [{ x: 106, on: true, color: '#88e6c7' }, { x: 268, on: bids > 0, color: '#f9cf8f' }, { x: 417, on: escrowed, color: '#efbe72' }, { x: 547, on: evidence, color: '#c9b9fa' }]
  lamps.forEach((lamp, i) => {
    const y = mobile && i > 1 ? 282 : 101
    ctx.fillStyle = lamp.on ? lamp.color : '#75837e'
    ctx.globalAlpha = lamp.on ? .75 + Math.sin(time * 4) * .18 : .55
    ctx.fillRect(lamp.x - 3, y, 6, 4)
    ctx.globalAlpha = 1
  })

  const animate = (name: string, target: Point) => {
    const previous = motion.positions[name] ?? target
    const distance = Math.hypot(target.x - previous.x, target.y - previous.y)
    const weight = reducedMotion || distance === 0 ? 1 : Math.min(1 - Math.exp(-delta * 7), 90 * delta / distance)
    const current = { x: previous.x + (target.x - previous.x) * weight, y: previous.y + (target.y - previous.y) * weight }
    motion.positions[name] = current
    return { at: current, moving: Math.hypot(current.x - previous.x, current.y - previous.y) > .12, left: current.x < previous.x - .1 }
  }
  const buyer = animate('Adam', phase === 'escrow' && !reducedMotion ? route(point.buyer, point.escrow, point.aisle, elapsed) : point.buyer)
  const provider = animate('Amelia', phase === 'quotes' && !reducedMotion ? route(point.provider, point.buyer, point.aisle, elapsed) : phase === 'delivery' && !reducedMotion ? route(point.provider, point.escrow, point.aisle, elapsed) : point.provider)
  const providerB = animate('Bob', point.providerB)
  const verifier = animate('Alex', phase === 'verdict' && !reducedMotion ? route(point.verifier, point.escrow, point.aisle, elapsed) : point.verifier)
  const people = [
    { name: 'Adam' as const, ...buyer },
    { name: 'Amelia' as const, ...provider },
    { name: 'Bob' as const, ...providerB },
    { name: 'Alex' as const, ...verifier },
  ]
  people.sort((a, b) => a.at.y - b.at.y).forEach((person) => drawPerson(ctx, art, person.name, person.at, person.moving && !reducedMotion, reducedMotion ? 0 : time, person.left))

  if (phase === 'quotes' && bids > 0) {
    ctx.fillStyle = '#d8fff0'
    ctx.fillRect(Math.round(provider.at.x - 7), Math.round(provider.at.y - 65), 10, 7)
    ctx.fillStyle = '#3a8a79'
    ctx.fillRect(Math.round(provider.at.x - 6), Math.round(provider.at.y - 64), 8, 1)
  }
  if (escrowed) {
    const glow = Math.sin(time * 3) * .15 + .75
    ctx.globalAlpha = glow
    ctx.fillStyle = '#f5c86e'
    ctx.fillRect(point.escrow.x - 3, point.escrow.y - 18, 6, 6)
    ctx.fillStyle = '#fff0b0'
    ctx.fillRect(point.escrow.x - 1, point.escrow.y - 17, 2, 4)
    ctx.globalAlpha = 1
  }
  if (phase === 'settlement' && settled) {
    const destination = outcome === 'ProviderPaid' ? point.provider : point.buyer
    const coin = route(point.escrow, destination, point.aisle, elapsed)
    ctx.fillStyle = '#f8d681'
    ctx.fillRect(Math.round(coin.x - 3), Math.round(coin.y - 35), 7, 7)
    ctx.fillStyle = '#fff4bf'
    ctx.fillRect(Math.round(coin.x - 1), Math.round(coin.y - 34), 2, 5)
  }
  ctx.fillStyle = '#263342'
  ctx.fillRect(0, height - 9, width, 4)
}

export function MarketRoom({ phase, bids, escrowed, evidence, settled, outcome }: {
  phase: Phase; bids: number; escrowed: boolean; evidence: boolean; settled: boolean; outcome: string | null
}) {
  const wrapper = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<SceneState>({ phase, bids, escrowed, evidence, settled, outcome })
  useEffect(() => { scene.current = { phase, bids, escrowed, evidence, settled, outcome } }, [phase, bids, escrowed, evidence, settled, outcome])
  useEffect(() => {
    let disposed = false
    let frame = 0
    const motion: Motion = { positions: {}, phase: null, phaseStart: 0, lastFrame: 0, mobile: null }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sources = [
      `${BASE}room-builder.png`, `${BASE}interiors.png`,
      ...PEOPLE.map((name) => `${BASE}${name}_idle_anim_16x16.png`),
      ...PEOPLE.map((name) => `${BASE}${name}_run_16x16.png`),
    ]
    const images = sources.map((src) => { const image = new Image(); image.src = src; return image })
    void Promise.all(images.map((image) => image.decode())).then(() => {
      if (disposed) return
      const art: Art = { room: images[0], interiors: images[1], idle: {}, run: {} }
      PEOPLE.forEach((name, i) => { art.idle[name] = images[i + 2]; art.run[name] = images[i + 6] })
      const draw = (timestamp: number) => {
        if (disposed || !wrapper.current || !canvas.current) return
        const mobile = wrapper.current.clientWidth < 500
        const width = mobile ? 320 : 640
        const height = mobile ? 420 : 320
        if (motion.mobile !== mobile) { motion.positions = {}; motion.mobile = mobile }
        if (motion.phase !== scene.current.phase) { motion.phase = scene.current.phase; motion.phaseStart = timestamp }
        const delta = motion.lastFrame ? Math.min((timestamp - motion.lastFrame) / 1000, .05) : 0
        motion.lastFrame = timestamp
        if (canvas.current.width !== width || canvas.current.height !== height) { canvas.current.width = width; canvas.current.height = height }
        const ctx = canvas.current.getContext('2d')
        if (ctx) room(ctx, art, width, height, mobile, scene.current, motion, reducedMotion.matches ? 0 : timestamp / 1000, reducedMotion.matches ? 0 : (timestamp - motion.phaseStart) / 1000, delta, reducedMotion.matches)
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
    }).catch(() => undefined)
    return () => { disposed = true; cancelAnimationFrame(frame) }
  }, [])
  return <div ref={wrapper} className="market-room"><canvas ref={canvas} role="img" aria-label="Top-down pixel-art trading room with a buyer desk, provider market, USDC escrow and verifier station" /></div>
}
