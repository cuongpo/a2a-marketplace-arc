import { useEffect, useRef } from 'react'

type Phase = 'request' | 'quotes' | 'escrow' | 'delivery' | 'verdict' | 'settlement' | null
type Role = 'buyer' | 'provider' | 'escrow' | 'verifier'
type Direction = 'left' | 'up' | 'right' | 'down'
type Point = { x: number; y: number }
type Art = { room: HTMLImageElement; interiors: HTMLImageElement; idle: Record<string, HTMLImageElement>; run: Record<string, HTMLImageElement> }
type SceneState = { phase: Phase; bids: number; escrowed: boolean; evidence: boolean; settled: boolean; outcome: string | null; speech: Record<Role, string> }
type Motion = { positions: Record<Role, Point>; phase: Phase; phaseStart: number; lastFrame: number; mobile: boolean | null }

const BASE = '/assets/modern-tiles/'
const PEOPLE = ['Adam', 'Amelia', 'Bob', 'Alex'] as const
const DIRECTION_FRAME: Record<Direction, number> = { left: 0, up: 6, right: 12, down: 18 }
const ROLE_PERSON: Record<Role, typeof PEOPLE[number]> = { buyer: 'Adam', provider: 'Amelia', escrow: 'Bob', verifier: 'Alex' }
const ROLE_COLOR: Record<Role, string> = { buyer: '#81bff0', provider: '#f6cb83', escrow: '#f4cc7b', verifier: '#c7b2f5' }

function sprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, x: number, y: number, w = sw, h = sh) {
  ctx.drawImage(img, sx, sy, sw, sh, Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}

function furniture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, sx: number, sy: number, sw: number, sh: number, w = sw, h = sh) {
  sprite(ctx, img, sx, sy, sw, sh, x, y, w, h)
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

function walkingPath(from: Point, to: Point, mobile: boolean): Point[] {
  const upperAisle = mobile ? 241 : 245
  const lowerAisle = mobile ? 410 : 365
  const center = mobile ? 160 : 320
  const fromUpper = from.y < (mobile ? 280 : 260)
  const toUpper = to.y < (mobile ? 280 : 260)
  if (fromUpper && toUpper) return [from, { x: from.x, y: upperAisle }, { x: to.x, y: upperAisle }, to]
  if (!fromUpper && !toUpper) return [from, { x: from.x, y: lowerAisle }, { x: to.x, y: lowerAisle }, to]
  if (fromUpper) return [from, { x: from.x, y: upperAisle }, { x: center, y: upperAisle }, { x: center, y: lowerAisle }, { x: to.x, y: lowerAisle }, to]
  return [from, { x: from.x, y: lowerAisle }, { x: center, y: lowerAisle }, { x: center, y: upperAisle }, { x: to.x, y: upperAisle }, to]
}

function route(from: Point, to: Point, mobile: boolean, elapsed: number): Point {
  const points = walkingPath(from, to, mobile)
  const distance = points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0)
  const travel = Math.max(4.5, distance / 60)
  const cycle = elapsed % (2 * travel + 3)
  const leg = cycle < travel ? cycle / travel : cycle < travel + 1.5 ? 1 : cycle < 2 * travel + 1.5 ? 1 - (cycle - travel - 1.5) / travel : 0
  return path(points, leg * leg * (3 - 2 * leg))
}

function drawPerson(ctx: CanvasRenderingContext2D, art: Art, name: typeof PEOPLE[number], point: Point, moving: boolean, direction: Direction, time: number) {
  ctx.fillStyle = '#24323d70'
  ctx.beginPath()
  ctx.ellipse(Math.round(point.x), Math.round(point.y - 1), 12, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  const image = moving ? art.run[name] : art.idle[name]
  const frame = DIRECTION_FRAME[direction] + Math.floor(time * (moving ? 5 : 1.5)) % 6
  sprite(ctx, image, frame * 16, 0, 16, 32, point.x - 14, point.y - 56, 28, 56)
}

function fitMessage(ctx: CanvasRenderingContext2D, message: string, width: number): string[] {
  const value = message.replace(/\s+/g, ' ').trim() || 'Waiting...'
  if (ctx.measureText(value).width <= width) return [value]
  let cut = value.length
  while (cut > 1 && ctx.measureText(value.slice(0, cut)).width > width) cut--
  const breakAt = value.lastIndexOf(' ', cut)
  const split = breakAt > cut / 2 ? breakAt : cut
  const first = value.slice(0, split).trimEnd()
  let second = value.slice(split).trimStart()
  if (ctx.measureText(second).width <= width) return [first, second]
  while (second.length > 1 && ctx.measureText(`${second}…`).width > width) second = second.slice(0, -1)
  return [first, `${second.trimEnd()}…`]
}

function drawBubble(ctx: CanvasRenderingContext2D, role: Role, message: string, center: number, top: number, width: number, active: boolean, roomWidth: number) {
  const left = Math.max(8, Math.min(roomWidth - width - 8, Math.round(center - width / 2)))
  const height = 46
  const edge = active ? ROLE_COLOR[role] : '#627c85'
  ctx.fillStyle = '#18212e99'
  ctx.fillRect(left + 3, top + 3, width, height)
  ctx.fillStyle = '#2d3441'
  ctx.fillRect(left, top, width, height)
  ctx.fillStyle = edge
  ctx.fillRect(left, top, width, 2)
  ctx.fillRect(left, top + height - 2, width, 2)
  ctx.fillRect(left, top, 2, height)
  ctx.fillRect(left + width - 2, top, 2, height)
  ctx.fillStyle = '#f8f1df'
  ctx.fillRect(left + 2, top + 2, width - 4, height - 4)
  const pointer = Math.max(left + 12, Math.min(left + width - 12, center))
  ctx.fillStyle = edge
  ctx.fillRect(pointer - 4, top + height, 9, 2)
  ctx.fillRect(pointer - 2, top + height + 2, 5, 3)
  ctx.fillStyle = '#f8f1df'
  ctx.fillRect(pointer - 2, top + height, 5, 2)
  ctx.font = 'bold 9px monospace'
  ctx.fillStyle = '#455466'
  ctx.fillText(role.toUpperCase(), left + 8, top + 12)
  ctx.font = 'bold 11px monospace'
  ctx.fillStyle = '#212c39'
  fitMessage(ctx, message, width - 16).forEach((line, i) => ctx.fillText(line, left + 8, top + 27 + i * 11))
}

function room(ctx: CanvasRenderingContext2D, art: Art, width: number, height: number, mobile: boolean, state: SceneState, motion: Motion, time: number, elapsed: number, delta: number, reducedMotion: boolean) {
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = false
  const { room: tiles, interiors: props } = art
  const { phase, bids, escrowed, evidence, settled, outcome, speech } = state
  for (let x = 0; x < width; x += 16) {
    for (let y = 0; y < 64; y += 16) sprite(ctx, tiles, 64, y < 48 ? 144 + (y % 32) : 192, 16, 16, x, y)
    for (let y = 64; y < height; y += 16) sprite(ctx, tiles, 224, 176, 16, 16, x, y)
  }
  ctx.fillStyle = '#756b67'
  ctx.fillRect(0, 61, width, 4)
  ctx.fillStyle = '#3d5059'
  ctx.fillRect(0, 65, width, 2)
  ctx.fillStyle = '#342d39'
  ctx.fillRect(0, height - 8, width, 8)
  ctx.fillRect(0, 0, 6, height)
  ctx.fillRect(width - 6, 0, 6, height)

  const centers = mobile ? { left: 78, right: 238, top: 218, bottom: 391 } : { left: 168, right: 492, top: 224, bottom: 354 }
  const point: Record<Role, Point> = {
    buyer: { x: centers.left, y: centers.top }, provider: { x: centers.right, y: centers.top },
    escrow: { x: centers.left, y: centers.bottom }, verifier: { x: centers.right, y: centers.bottom },
  }
  const deskX = mobile ? [12, 172] : [102, 426]
  const topDeskY = mobile ? 132 : 145
  const bottomDeskY = mobile ? 304 : 276
  const bubbleWidth = mobile ? 140 : 170
  const topBubbleY = mobile ? 80 : 90
  const bottomBubbleY = mobile ? 251 : 225

  // Paired workstations face north toward their monitors. The central lane stays clear for walking.
  if (mobile) {
    furniture(ctx, props, 24, 8, 96, 0, 48, 48)
    furniture(ctx, props, 248, 8, 96, 0, 48, 48)
    furniture(ctx, props, 8, 338, 208, 704, 32, 48, 26, 39)
    furniture(ctx, props, 286, 338, 208, 704, 32, 48, 26, 39)
    furniture(ctx, props, 137, 211, 48, 672, 48, 32, 46, 35)
    furniture(ctx, props, 143, 218, 112, 208, 48, 32, 34, 18)
  } else {
    furniture(ctx, props, 83, 8, 96, 0, 48, 48)
    furniture(ctx, props, 296, 8, 96, 0, 48, 48)
    furniture(ctx, props, 509, 8, 96, 0, 48, 48)
    furniture(ctx, props, 10, 279, 176, 1104, 80, 48, 75, 43)
    furniture(ctx, props, 555, 279, 176, 1104, 80, 48, 75, 43)
    furniture(ctx, props, 280, 190, 48, 672, 48, 32, 80, 60)
    furniture(ctx, props, 293, 205, 112, 208, 48, 32, 54, 33)
    furniture(ctx, props, 14, 143, 208, 704, 32, 48)
    furniture(ctx, props, 594, 143, 208, 704, 32, 48)
  }
  for (const x of deskX) {
    furniture(ctx, props, x, topDeskY, 0, 576, 112, 32)
    furniture(ctx, props, x, bottomDeskY, 0, 576, 112, 32)
  }

  const move = (role: Role, target: Point) => {
    const previous = motion.positions[role] ?? target
    const distance = Math.hypot(target.x - previous.x, target.y - previous.y)
    const weight = reducedMotion || distance === 0 ? 1 : Math.min(1 - Math.exp(-delta * 7), 75 * delta / distance)
    const current = { x: previous.x + (target.x - previous.x) * weight, y: previous.y + (target.y - previous.y) * weight }
    motion.positions[role] = current
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const moving = Math.hypot(dx, dy) > .12
    const direction: Direction = !moving ? 'up' : Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'left' : 'right')
    return { role, at: current, moving, direction }
  }
  const buyer = move('buyer', phase === 'escrow' && !reducedMotion ? route(point.buyer, point.escrow, mobile, elapsed) : point.buyer)
  const provider = move('provider', phase === 'quotes' && !reducedMotion ? route(point.provider, point.buyer, mobile, elapsed) : phase === 'delivery' && !reducedMotion ? route(point.provider, point.escrow, mobile, elapsed) : point.provider)
  const escrow = move('escrow', point.escrow)
  const verifier = move('verifier', phase === 'verdict' && !reducedMotion ? route(point.verifier, point.escrow, mobile, elapsed) : point.verifier)
  const people = [buyer, provider, escrow, verifier]
  people.sort((a, b) => a.at.y - b.at.y).forEach((person) => drawPerson(ctx, art, ROLE_PERSON[person.role], person.at, person.moving && !reducedMotion, person.direction, time))

  if (bids > 0) {
    ctx.fillStyle = '#e8c573'
    ctx.fillRect(point.provider.x + 12, point.provider.y - 30, 5, 5)
  }
  if (escrowed) {
    ctx.globalAlpha = .78 + Math.sin(time * 2) * .14
    ctx.fillStyle = '#f5c86e'
    ctx.fillRect(point.escrow.x + 12, point.escrow.y - 31, 6, 6)
    ctx.globalAlpha = 1
  }
  if (evidence) {
    ctx.fillStyle = '#bcacf2'
    ctx.fillRect(point.verifier.x + 12, point.verifier.y - 31, 6, 6)
  }
  if (phase === 'settlement' && settled) {
    const destination = outcome === 'ProviderPaid' ? point.provider : point.buyer
    const coin = route(point.escrow, destination, mobile, elapsed)
    ctx.fillStyle = '#f8d681'
    ctx.fillRect(Math.round(coin.x - 3), Math.round(coin.y - 31), 7, 7)
  }
  drawBubble(ctx, 'buyer', speech.buyer, centers.left, topBubbleY, bubbleWidth, phase === 'request', width)
  drawBubble(ctx, 'provider', speech.provider, centers.right, topBubbleY, bubbleWidth, phase === 'quotes' || phase === 'delivery', width)
  drawBubble(ctx, 'escrow', speech.escrow, centers.left, bottomBubbleY, bubbleWidth, phase === 'escrow' || phase === 'settlement', width)
  drawBubble(ctx, 'verifier', speech.verifier, centers.right, bottomBubbleY, bubbleWidth, phase === 'verdict', width)
}

export function MarketRoom({ phase, bids, escrowed, evidence, settled, outcome, speech }: SceneState) {
  const wrapper = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scene = useRef<SceneState>({ phase, bids, escrowed, evidence, settled, outcome, speech })
  useEffect(() => { scene.current = { phase, bids, escrowed, evidence, settled, outcome, speech } }, [phase, bids, escrowed, evidence, settled, outcome, speech])
  useEffect(() => {
    let disposed = false
    let frame = 0
    const motion: Motion = { positions: {} as Record<Role, Point>, phase: null, phaseStart: 0, lastFrame: 0, mobile: null }
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
        const mobile = window.innerWidth <= 500
        const width = mobile ? 320 : 640
        const height = mobile ? 440 : 380
        if (motion.mobile !== mobile) { motion.positions = {} as Record<Role, Point>; motion.mobile = mobile }
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
  return <div ref={wrapper} className="market-room"><canvas ref={canvas} role="img" aria-label="Pixel office with buyer, provider, escrow and verifier desks; speech bubbles show the selected trade's recorded state" /><div className="sr-only">Buyer: {speech.buyer}. Provider: {speech.provider}. Escrow: {speech.escrow}. Verifier: {speech.verifier}.</div></div>
}
