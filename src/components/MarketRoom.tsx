import { useEffect, useRef, useState } from 'react'

type Phase = 'request' | 'quotes' | 'escrow' | 'delivery' | 'verdict' | 'settlement' | null
type Role = 'buyer' | 'provider' | 'escrow' | 'verifier'
type Direction = 'left' | 'up' | 'right' | 'down'
type Point = { x: number; y: number }
type Art = { room: HTMLImageElement; interiors: HTMLImageElement; idle: Record<string, HTMLImageElement>; run: Record<string, HTMLImageElement> }
export type FloorProvider = { id: string; name: string; price: string; etaMinutes: number; winner: boolean; excluded: boolean }
type SceneState = { phase: Phase; providers: FloorProvider[]; selectedProviderId: string | null; onSelectProvider: (id: string | null) => void; escrowed: boolean; evidence: boolean; settled: boolean; outcome: string | null; speech: Record<Role, string> }
type Motion = { positions: Record<string, Point>; phase: Phase; phaseStart: number; lastFrame: number; mobile: boolean | null; visibleIds: string }

const BASE = '/assets/modern-tiles/'
const PEOPLE = ['Adam', 'Amelia', 'Bob', 'Alex'] as const
// LimeZu's 24-frame strips are right, up, left, down (six frames each).
const DIRECTION_FRAME: Record<Direction, number> = { right: 0, up: 6, left: 12, down: 18 }
const ROLE_PERSON: Record<Role, typeof PEOPLE[number]> = { buyer: 'Adam', provider: 'Amelia', escrow: 'Bob', verifier: 'Alex' }
const ROLE_COLOR: Record<Role, string> = { buyer: '#81bff0', provider: '#f6cb83', escrow: '#f4cc7b', verifier: '#c7b2f5' }

function sprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, x: number, y: number, w = sw, h = sh) {
  ctx.drawImage(img, sx, sy, sw, sh, Math.round(x), Math.round(y), Math.round(w), Math.round(h))
}

function furniture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, sx: number, sy: number, sw: number, sh: number, w = sw, h = sh) {
  sprite(ctx, img, sx, sy, sw, sh, x, y, w, h)
}

function deskPod(ctx: CanvasRenderingContext2D, x: number, y: number, width: number) {
  const middle = Math.round(width / 2)
  ctx.fillStyle = '#303746'
  ctx.fillRect(x + 2, y + 28, width - 4, 8)
  ctx.fillRect(x, y + 3, 4, 33)
  ctx.fillRect(x + width - 4, y + 3, 4, 33)
  ctx.fillRect(x + middle - 2, y + 4, 4, 31)
  ctx.fillStyle = '#c5b78f'
  ctx.fillRect(x + 5, y + 5, width - 10, 22)
  ctx.fillStyle = '#ead9a8'
  ctx.fillRect(x + 6, y + 6, width - 12, 15)
  ctx.fillStyle = '#a89977'
  ctx.fillRect(x + 6, y + 22, width - 12, 3)
  for (const center of [x + middle / 2, x + middle + middle / 2]) {
    const screen = Math.round(center - 11)
    ctx.fillStyle = '#323b50'
    ctx.fillRect(screen, y - 10, 22, 17)
    ctx.fillStyle = '#4f91b6'
    ctx.fillRect(screen + 3, y - 7, 16, 10)
    ctx.fillStyle = '#8ac9df'
    ctx.fillRect(screen + 5, y - 5, 8, 2)
    ctx.fillStyle = '#3a4252'
    ctx.fillRect(screen + 9, y + 7, 4, 4)
    ctx.fillRect(screen + 3, y + 14, 17, 3)
    ctx.fillStyle = '#7d8d98'
    ctx.fillRect(screen + 5, y + 15, 13, 1)
  }
  ctx.fillStyle = '#f4f0df'
  ctx.fillRect(x + middle - 6, y + 9, 12, 9)
  ctx.fillStyle = '#8297a5'
  ctx.fillRect(x + middle - 4, y + 11, 8, 1)
  ctx.fillRect(x + middle - 4, y + 14, 6, 1)
  ctx.fillStyle = '#44485a'
  ctx.fillRect(x + middle - 12, y + 31, 24, 15)
  ctx.fillStyle = '#626b7c'
  ctx.fillRect(x + middle - 9, y + 33, 18, 12)
  ctx.fillStyle = '#343a4b'
  ctx.fillRect(x + middle - 6, y + 45, 12, 4)
}

function nameplate(ctx: CanvasRenderingContext2D, role: Role, point: Point, active: boolean, roomHeight: number, label?: string, winner = false) {
  const title = label ? `${winner ? '★ ' : ''}${label.slice(0, 12)}` : role === 'provider' ? 'Provider agent' : role === 'buyer' ? 'Buyer agent' : role === 'escrow' ? 'Escrow' : 'Verifier'
  ctx.font = 'bold 9px sans-serif'
  const width = Math.ceil(ctx.measureText(title).width) + 24
  const x = Math.round(point.x - width / 2)
  const y = Math.min(roomHeight - 25, Math.round(point.y + 5))
  ctx.fillStyle = '#12191fe8'
  ctx.beginPath()
  ctx.roundRect(x, y, width, 18, 9)
  ctx.fill()
  ctx.fillStyle = active ? ROLE_COLOR[role] : '#70caaa'
  ctx.beginPath()
  ctx.arc(x + 9, y + 9, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fffaf0'
  ctx.fillText(title, x + 17, y + 12)
}

function shownProviders(providers: FloorProvider[], selectedId: string | null, mobile: boolean): FloorProvider[] {
  const capacity = mobile ? 2 : 3
  const shown = providers.slice(0, capacity)
  for (const essential of [providers.find((provider) => provider.winner), providers.find((provider) => provider.id === selectedId)]) {
    if (!essential || shown.some((provider) => provider.id === essential.id)) continue
    const replace = shown.findIndex((provider) => !provider.winner && provider.id !== selectedId)
    shown[replace < 0 ? shown.length - 1 : replace] = essential
  }
  return shown.sort((a, b) => providers.indexOf(a) - providers.indexOf(b))
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
  const upperAisle = 260
  const lowerAisle = mobile ? 400 : 365
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

function drawPerson(ctx: CanvasRenderingContext2D, art: Art, name: typeof PEOPLE[number], point: Point, moving: boolean, direction: Direction, time: number, mobile: boolean) {
  ctx.fillStyle = '#24323d70'
  ctx.beginPath()
  ctx.ellipse(Math.round(point.x), Math.round(point.y - 1), mobile ? 15 : 12, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  const image = moving ? art.run[name] : art.idle[name]
  const frame = DIRECTION_FRAME[direction] + Math.floor(time * (moving ? 5 : 1.5)) % 6
  sprite(ctx, image, frame * 16, 0, 16, 32, point.x - (mobile ? 18 : 14), point.y - (mobile ? 64 : 56), mobile ? 36 : 28, mobile ? 64 : 56)
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

function drawBubble(ctx: CanvasRenderingContext2D, role: Role, message: string, center: number, top: number, width: number, active: boolean, roomWidth: number, label?: string) {
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
  ctx.fillText((label ?? role).slice(0, 19).toUpperCase(), left + 8, top + 12)
  ctx.font = 'bold 11px monospace'
  ctx.fillStyle = '#212c39'
  fitMessage(ctx, message, width - 16).forEach((line, i) => ctx.fillText(line, left + 8, top + 27 + i * 11))
}

function room(ctx: CanvasRenderingContext2D, art: Art, width: number, height: number, mobile: boolean, state: SceneState, motion: Motion, focusedRole: string | null, time: number, elapsed: number, delta: number, reducedMotion: boolean) {
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = false
  const { room: tiles, interiors: props } = art
  const { phase, providers, selectedProviderId, escrowed, evidence, settled, outcome, speech } = state
  for (let x = 0; x < width; x += 16) {
    for (let y = 0; y < 64; y += 16) sprite(ctx, tiles, 64, y < 48 ? 144 + (y % 32) : 192, 16, 16, x, y)
    for (let y = 64; y < height; y += 16) sprite(ctx, tiles, 224, 144, 16, 16, x, y)
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
  const deskX = mobile ? [12, 180] : [102, 426]
  const topDeskY = mobile ? 132 : 145
  const bottomDeskY = mobile ? 304 : 276
  const bubbleWidth = mobile ? 140 : 170
  const topBubbleY = mobile ? 80 : 90
  const bottomBubbleY = mobile ? 248 : 247

  // Paired workstations face north toward their monitors. The central lane stays clear for walking.
  if (mobile) {
    furniture(ctx, props, 24, 8, 96, 0, 48, 48)
    furniture(ctx, props, 248, 8, 96, 0, 48, 48)
    furniture(ctx, props, 8, 370, 208, 704, 32, 48, 26, 39)
    furniture(ctx, props, 286, 370, 208, 704, 32, 48, 26, 39)
  } else {
    furniture(ctx, props, 83, 8, 96, 0, 48, 48)
    furniture(ctx, props, 296, 8, 96, 0, 48, 48)
    furniture(ctx, props, 509, 8, 96, 0, 48, 48)
    furniture(ctx, props, 10, 279, 176, 1104, 80, 48, 75, 43)
    furniture(ctx, props, 555, 279, 176, 1104, 80, 48, 75, 43)
    furniture(ctx, props, 14, 143, 208, 704, 32, 48)
    furniture(ctx, props, 594, 143, 208, 704, 32, 48)
  }
  for (const x of deskX) {
    deskPod(ctx, x, topDeskY, mobile ? 128 : 150)
    deskPod(ctx, x, bottomDeskY, mobile ? 128 : 150)
  }

  const visibleProviders = shownProviders(providers, selectedProviderId, mobile)
  const providerSlots = mobile ? [206, 275] : [350, 453, 556]
  const providerPoints = new Map(visibleProviders.map((provider, index) => [provider.id, { x: providerSlots[index], y: centers.top }]))
  if (visibleProviders.length === 1) providerPoints.set(visibleProviders[0].id, point.provider)
  const visibleIds = visibleProviders.map((provider) => provider.id).join('|')
  if (motion.visibleIds !== visibleIds) {
    if (phase !== 'quotes') visibleProviders.forEach((provider) => { motion.positions[`quote:${provider.id}`] = providerPoints.get(provider.id)! })
    motion.visibleIds = visibleIds
  }

  const move = (key: string, role: Role, target: Point, arrive = false, arrivalIndex = 0) => {
    if (!motion.positions[key] && arrive && phase === 'quotes' && !reducedMotion) motion.positions[key] = { x: width - 38 - arrivalIndex * 17, y: 260 }
    const previous = motion.positions[key] ?? target
    const distance = Math.hypot(target.x - previous.x, target.y - previous.y)
    const weight = reducedMotion || distance === 0 ? 1 : Math.min(1 - Math.exp(-delta * 7), 75 * delta / distance)
    const current = { x: previous.x + (target.x - previous.x) * weight, y: previous.y + (target.y - previous.y) * weight }
    motion.positions[key] = current
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const moving = Math.hypot(dx, dy) > .12
    const direction: Direction = !moving ? 'down' : Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'left' : 'right')
    return { key, role, at: current, moving, direction }
  }
  const buyer = move('buyer', 'buyer', phase === 'escrow' && !reducedMotion ? route(point.buyer, point.escrow, mobile, elapsed) : point.buyer)
  const escrow = move('escrow', 'escrow', point.escrow)
  const verifier = move('verifier', 'verifier', phase === 'verdict' && !reducedMotion ? route(point.verifier, point.escrow, mobile, elapsed) : point.verifier)
  const providerPeople = visibleProviders.map((provider, index) => {
    const base = providerPoints.get(provider.id)!
    const target = provider.winner && phase === 'delivery' && !reducedMotion ? route(base, point.verifier, mobile, elapsed) : base
    return move(`quote:${provider.id}`, 'provider', target, true, index)
  })
  const placeholder = providers.length ? null : move('provider', 'provider', point.provider)
  const people = [buyer, ...providerPeople, ...(placeholder ? [placeholder] : []), escrow, verifier]
  people.sort((a, b) => a.at.y - b.at.y).forEach((person) => {
    const index = person.key.startsWith('quote:') ? providers.findIndex((provider) => `quote:${provider.id}` === person.key) : -1
    drawPerson(ctx, art, index >= 0 ? PEOPLE[(index + 1) % PEOPLE.length] : ROLE_PERSON[person.role], person.at, person.moving && !reducedMotion, person.direction, time, mobile)
  })
  const defaultSpeaker = phase === 'request' ? 'buyer' : phase === 'quotes' || phase === 'delivery' ? visibleProviders[0] ? `quote:${visibleProviders[0].id}` : 'provider' : phase === 'escrow' || phase === 'settlement' ? 'escrow' : phase === 'verdict' ? 'verifier' : settled ? 'escrow' : null
  const speaking = focusedRole && people.some((person) => person.key === focusedRole) ? focusedRole : selectedProviderId && people.some((person) => person.key === `quote:${selectedProviderId}`) ? `quote:${selectedProviderId}` : defaultSpeaker
  people.forEach((person) => {
    const provider = providers.find((quote) => `quote:${quote.id}` === person.key)
    nameplate(ctx, person.role, person.at, person.key === speaking, height, provider?.name.slice(0, mobile ? 7 : 12), provider?.winner)
  })

  visibleProviders.forEach((provider) => {
    const at = motion.positions[`quote:${provider.id}`]
    if (!at) return
    ctx.fillStyle = provider.winner ? '#f4d269' : provider.excluded ? '#c8827d' : '#78c9a9'
    ctx.fillRect(Math.round(at.x + 10), Math.round(at.y - 34), 5, 5)
  })
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
    const winnerPoint = providers.find((provider) => provider.winner)
    const destination = outcome === 'ProviderPaid' && winnerPoint ? providerPoints.get(winnerPoint.id) ?? point.provider : point.buyer
    const coin = route(point.escrow, destination, mobile, elapsed)
    ctx.fillStyle = '#f8d681'
    ctx.fillRect(Math.round(coin.x - 3), Math.round(coin.y - 31), 7, 7)
  }
  if (speaking) {
    const person = people.find((entry) => entry.key === speaking)
    const provider = providers.find((quote) => `quote:${quote.id}` === speaking)
    const role = provider ? 'provider' : speaking as Role
    const upper = role === 'buyer' || role === 'provider'
    const message = provider ? `${provider.price} USDC · ETA ${provider.etaMinutes}m${provider.winner ? ' · WINNER' : provider.excluded ? ' · EXCLUDED' : ''}` : speech[role]
    drawBubble(ctx, role, message, person?.at.x ?? width / 2, upper ? topBubbleY : bottomBubbleY, upper ? bubbleWidth : mobile ? 140 : 150, true, width, provider?.name)
  }
}

export function MarketRoom({ phase, providers, selectedProviderId, onSelectProvider, escrowed, evidence, settled, outcome, speech }: SceneState) {
  const wrapper = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const motion = useRef<Motion>({ positions: {}, phase: null, phaseStart: 0, lastFrame: 0, mobile: null, visibleIds: '' })
  const focused = useRef<string | null>(null)
  const [focusedRole, setFocusedRole] = useState<string | null>(null)
  const scene = useRef<SceneState>({ phase, providers, selectedProviderId, onSelectProvider, escrowed, evidence, settled, outcome, speech })
  useEffect(() => { scene.current = { phase, providers, selectedProviderId, onSelectProvider, escrowed, evidence, settled, outcome, speech } }, [phase, providers, selectedProviderId, onSelectProvider, escrowed, evidence, settled, outcome, speech])
  useEffect(() => { if (selectedProviderId) { focused.current = `quote:${selectedProviderId}`; setFocusedRole(focused.current) } }, [selectedProviderId])
  useEffect(() => {
    let disposed = false
    let frame = 0
    const movement = motion.current
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
        const mobile = window.innerWidth <= 620
        const width = mobile ? 320 : 640
        const height = mobile ? 440 : 400
        if (movement.mobile !== mobile) { movement.positions = {}; movement.visibleIds = ''; movement.mobile = mobile }
        if (movement.phase !== scene.current.phase) { movement.phase = scene.current.phase; movement.phaseStart = timestamp }
        const delta = movement.lastFrame ? Math.min((timestamp - movement.lastFrame) / 1000, .05) : 0
        movement.lastFrame = timestamp
        if (canvas.current.width !== width || canvas.current.height !== height) { canvas.current.width = width; canvas.current.height = height }
        const ctx = canvas.current.getContext('2d')
        if (ctx) room(ctx, art, width, height, mobile, scene.current, movement, focused.current, reducedMotion.matches ? 0 : timestamp / 1000, reducedMotion.matches ? 0 : (timestamp - movement.phaseStart) / 1000, delta, reducedMotion.matches)
        frame = requestAnimationFrame(draw)
      }
      frame = requestAnimationFrame(draw)
    }).catch(() => undefined)
    return () => { disposed = true; cancelAnimationFrame(frame) }
  }, [])
  const select = (key: string | null) => {
    focused.current = key
    setFocusedRole(key)
    onSelectProvider(key?.startsWith('quote:') ? key.slice(6) : null)
  }
  const selectable = () => {
    const all = scene.current.providers
    const visible = shownProviders(all, scene.current.selectedProviderId, window.innerWidth <= 620).map((provider) => `quote:${provider.id}`)
    return ['buyer', ...(visible.length ? visible : ['provider']), 'escrow', 'verifier']
  }
  return <div ref={wrapper} className="market-room"><canvas ref={canvas} role="button" tabIndex={0} aria-label="Pixel office. Select an agent to read its current message; press Enter to cycle agents" onClick={(event) => {
    const element = event.currentTarget
    const bounds = element.getBoundingClientRect()
    const x = (event.clientX - bounds.left) * element.width / bounds.width
    const y = (event.clientY - bounds.top) * element.height / bounds.height
    const nearest = selectable().map((key) => ({ key, distance: Math.hypot(x - (motion.current.positions[key]?.x ?? -100), y - (motion.current.positions[key]?.y ?? -100)) })).sort((a, b) => a.distance - b.distance)[0]
    select(nearest.distance < 48 ? nearest.key : null)
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') select(null)
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const keys = selectable()
      select(keys[(keys.indexOf(focused.current ?? 'verifier') + 1) % keys.length])
    }
  }} /><div className="sr-only">Buyer: {speech.buyer}. Provider: {providers.map((provider) => `${provider.name} bids ${provider.price} USDC, ETA ${provider.etaMinutes} minutes${provider.winner ? ', selected winner' : ''}`).join('; ') || speech.provider}. Escrow: {speech.escrow}. Verifier: {speech.verifier}. {focusedRole ? `Selected ${focusedRole}.` : ''}</div></div>
}
