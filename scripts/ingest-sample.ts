// Sample device ingestion adapter. Reads one JSON object per line from stdin, signs each with the device
// key, and posts it to the mission's observation endpoint, authorised by the bound provider wallet (PROVIDER_KEY).
//
//   Serial gauge printing JSON lines such as {"mm":412,"serial":"GAUGE-0042"}:
//     stty -F /dev/ttyUSB0 9600 raw && head -n1 /dev/ttyUSB0 | \
//       PROVIDER_KEY=0x... DEVICE_KEY=0x... bun run scripts/ingest-sample.ts --mission <localMissionId> --onchain-id 7 --tile B2
//   HTTP: pipe the body of any HTTP response through the same command (curl http://gauge.local/latest | ...).
//
// Interface for other adapters: produce { valueMm, rawPayload, serial } and call signReading() then POST.
import { signReading } from './sign-reading'
import { accountFromEnv, signedPost } from './lib/signed-api'
import type { Hex } from 'viem'

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const key = process.env.DEVICE_KEY as Hex | undefined
const mission = arg('mission')
const onchainId = arg('onchain-id')
const tile = arg('tile')
if (!key || !mission || !onchainId || !tile) throw new Error('Need DEVICE_KEY and --mission --onchain-id --tile')
const api = process.env.FQ_API ?? 'http://127.0.0.1:3001'

const text = await new Response(Bun.stdin.stream()).text()
const line = text.split('\n').find((l) => l.trim().startsWith('{'))
if (!line) throw new Error('No JSON line received from the device')
const raw = JSON.parse(line) as { mm?: number; serial?: string }
if (typeof raw.mm !== 'number') throw new Error('Device line must contain a numeric "mm" field')
const body = await signReading({ key, onchainId, tile, valueMm: raw.mm, rawPayload: raw, serial: raw.serial, kind: 'device-adapter' })
// The upload itself is authorised by the PROVIDER wallet bound to the mission (PROVIDER_KEY), separate from the device key.
await signedPost(api, accountFromEnv('PROVIDER_KEY'), `/missions/${mission}/observation`, body)
console.log('observation queued; the provider agent will validate it and submit its hash')
