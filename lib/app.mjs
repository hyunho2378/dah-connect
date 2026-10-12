// DAH Connect: 조립. CLI 와 시험이 같은 조립을 쓴다.
import { DEFAULT_API_BASE, DEFAULT_ISSUER, DEFAULT_ORIGINS, DEV_ORIGINS, SERVE_PORTS, configDir, devOverrides } from './config.mjs'
import { createOAuth } from './oauth.mjs'
import { createPairing } from './pairing.mjs'
import { createResponses } from './responses.mjs'
import { createLocalServer } from './server.mjs'
import { createStore } from './store.mjs'

export function originsFrom({ env = process.env, extra = [], dev = false } = {}) {
  const list = [...DEFAULT_ORIGINS]
  const fromEnv = String(env.DAH_CONNECT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const wantDev = dev || env.DAH_CONNECT_DEV === '1'
  for (const o of [...fromEnv, ...extra, ...(wantDev ? DEV_ORIGINS : [])]) {
    // 허용 목록은 http(s) 출처만, 와일드카드는 포트 자리(:*)에만
    if (/^https?:\/\/[^/*\s]+(:\d+|:\*)?$/.test(o) && !list.includes(o)) list.push(o)
  }
  return list
}

export async function createApp({ env = process.env, fetchImpl = globalThis.fetch, dir, backend, keychain, origins, now, log, ports = SERVE_PORTS } = {}) {
  const dev = devOverrides(env)
  const issuer = dev.issuer || DEFAULT_ISSUER
  const apiBase = dev.apiBase || DEFAULT_API_BASE
  const store = await createStore({ dir: dir || configDir(env), backend: backend || (env.DAH_CONNECT_STORE === 'file' ? 'file' : 'auto'), keychain }).init()
  const host = await store.hostInfo()
  const oauth = createOAuth({ store, fetchImpl, issuer, apiBase, ...(now ? { now } : {}) })
  const responses = createResponses({ oauth, fetchImpl, apiBase })
  const pairing = createPairing({ store, ...(now ? { now } : {}) })
  const server = createLocalServer({ oauth, responses, store, pairing, host, origins: origins || originsFrom({ env }), log, ports, ...(now ? { now } : {}) })
  return { store, oauth, responses, pairing, server, host, issuer, apiBase }
}
