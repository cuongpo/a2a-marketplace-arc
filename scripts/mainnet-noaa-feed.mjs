// Fetches a real NOAA preliminary water-level observation for a pilot mission.
// --write-feed places the exact source value/time into the winning provider's local feed file.
// The provider still signs its own claim; NOAA does not endorse this marketplace or signature.
// oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment, typescript/no-unsafe-return
import { readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, http } from 'viem'
import { arc } from 'viem/chains'

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const missionId = positional[0]
const stationId = positional[1] ?? '9414290'
const stationName = { '9414290': 'San Francisco', '9455760': 'Nikiski' }[stationId]
const writeFeed = process.argv.includes('--write-feed')
if (!/^[0-9a-f]{8}$/.test(missionId ?? '') || !stationName || process.argv.slice(2).some((arg) => arg.startsWith('--') && arg !== '--write-feed') || positional.length > 2)
  throw new Error('Usage: node scripts/mainnet-noaa-feed.mjs <mission-id> [9414290|9455760] [--write-feed]')
const dep = JSON.parse(readFileSync('src/deployments/arc-mainnet.json', 'utf8'))
if (dep.chainId !== 5042 || !/^0x[0-9a-fA-F]{40}$/.test(dep.escrow ?? '')) throw new Error('Arc Mainnet escrow is missing')
const client = createPublicClient({ chain: arc, transport: http('https://rpc.mainnet.arc.io', { timeout: 20_000, retryCount: 3 }) })
if (await client.getChainId() !== 5042) throw new Error('RPC is not Arc Mainnet')
const escrowAbi = JSON.parse(readFileSync('contracts/out/MissionEscrow.sol/MissionEscrow.json', 'utf8')).abi
const sourceUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=${stationId}&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json&application=A2AMarketplace`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const providers = {
  '0x10ed7f11ed74f5bfb4a2c2de9eaeaa40cf3ff569': 'feed-mainnet-a.json',
  '0xb6a45eb88dd2bde166d61e5bcdbfdc461906e314': 'feed-mainnet-b.json',
}

for (let attempt = 0; attempt < (writeFeed ? 60 : 1); attempt++) {
  const response = await fetch(`http://127.0.0.1:3001/api/missions/${missionId}`)
  if (!response.ok) throw new Error(`Mission ${missionId} is not available from the local mainnet backend`)
  const mission = await response.json()
  if (!mission.chain?.onchainId) {
    console.log(`Mission ${missionId} stage ${mission.stage}; waiting for onchain funding`)
    if (writeFeed) { await wait(30_000); continue }
    break
  }
  const winningProvider = mission.chain.provider?.toLowerCase()
  const feedPath = providers[winningProvider]
  if (!feedPath) throw new Error('Winning provider is not one of the two isolated pilot wallets')
  const onchain = await client.readContract({ address: dep.escrow, abi: escrowAbi, functionName: 'getMission', args: [BigInt(mission.chain.onchainId)] })
  const createdAt = Number(onchain.createdAt)
  const latest = await (await fetch(sourceUrl)).json()
  const sample = latest.data?.[0]
  if (!sample || latest.metadata?.id !== stationId) throw new Error(`NOAA has no latest ${stationName} sample: ${JSON.stringify(latest.error ?? {})}`)
  const sourceTimeUtc = `${sample.t} UTC`
  const observedAtUnix = Date.parse(sample.t.replace(' ', 'T') + 'Z') / 1000
  const valueMm = Math.round(Number(sample.v) * 1000)
  const fresh = Number.isSafeInteger(observedAtUnix) && observedAtUnix >= createdAt && Date.now() / 1000 - observedAtUnix <= 18 * 60
  if (!Number.isInteger(valueMm) || valueMm < 0 || valueMm > 12_000) throw new Error(`NOAA level ${sample.v} m is outside this pilot's 0–12000 mm source bounds`)
  console.log(`NOAA ${stationName} station ${stationId}: ${valueMm} mm MLLW at ${sourceTimeUtc}; mission created ${new Date(createdAt * 1000).toISOString()}; eligible=${fresh}; app plausibility=${valueMm <= 2500 ? 'pass' : 'reject'}`)
  if (!fresh) {
    if (writeFeed) { await wait(30_000); continue }
    break
  }
  if (!writeFeed) break
  const existing = JSON.parse(readFileSync(feedPath, 'utf8'))
  if (existing[mission.spec.tile]) throw new Error(`${feedPath} already contains a reading for ${mission.spec.tile}; inspect it before overwriting`)
  const note = `NOAA CO-OPS preliminary six-minute water level, ${stationName} station ${stationId}, MLLW datum. Source reports ${sample.v} m at ${sourceTimeUtc}; converted to ${valueMm} mm. Provider relays a public API observation; its device signature proves relay key control, not independent sensor ownership.`
  writeFileSync(feedPath, JSON.stringify({ ...existing, [mission.spec.tile]: { valueMm, observedAtUnix, sourceUrl, stationId, datum: 'MLLW', sourceTimeUtc, note } }, null, 2) + '\n', { mode: 0o600 })
  console.log(`Wrote ${feedPath} for winning provider ${mission.chain.provider}; the running provider will sign and submit it`)
  break
}
