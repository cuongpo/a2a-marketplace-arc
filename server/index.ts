import { account, assertPublicReadOnlyConfig, assertRoleSigningAllowed, config, hasRole, NETWORK, PUBLIC_READ_ONLY } from './env'
import { requireDeployment } from './chain'
import { startLoop } from './pipeline'
import { handle } from './http'

// Read endpoints are public. Every mutating endpoint requires a wallet-signed request (server/auth.ts).
assertPublicReadOnlyConfig()
if (NETWORK === 'mainnet' && !PUBLIC_READ_ONLY) {
  requireDeployment()
  assertRoleSigningAllowed('buyer')
  if (!hasRole('buyer') || !hasRole('verifier')) throw new Error('Mainnet backend requires isolated buyer and verifier signer keys')
  account('buyer')
  account('verifier')
}
Bun.serve({
  port: config.port,
  hostname: '127.0.0.1',
  fetch: handle,
})
if (!PUBLIC_READ_ONLY) startLoop()
console.log(`[a2a-marketplace] API on http://127.0.0.1:${config.port} (${NETWORK}); ${PUBLIC_READ_ONLY ? 'public read-only pilot, no signing keys' : 'wallet-signed writes; agents running'}`)
