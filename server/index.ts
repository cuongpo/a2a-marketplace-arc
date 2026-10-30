import { config, NETWORK } from './env'
import { startLoop } from './pipeline'
import { handle } from './http'

// Read endpoints are public. Every mutating endpoint requires a wallet-signed request (server/auth.ts).
Bun.serve({
  port: config.port,
  hostname: '127.0.0.1',
  fetch: handle,
})
startLoop()
console.log(`[fieldquest] API on http://127.0.0.1:${config.port} (${NETWORK}); wallet-signed writes; agents running`)
