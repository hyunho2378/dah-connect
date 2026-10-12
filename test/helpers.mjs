import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../lib/app.mjs'
import { createFake } from './fake-openai.mjs'

export { createFake }

const opened = []
/** 시험이 도중에 실패해도 서버가 남아 프로세스가 멈추지 않게 모두 닫는다 */
export const closeApps = () => Promise.all(opened.splice(0).map((a) => a.server.close().catch(() => {})))

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dah-connect-test-'))
}

/** 가짜 OpenAI 에 연결된 앱(파일 저장소, 키체인 사용 안 함, 허용 사이트는 시험용) */
export async function makeApp(fake, { dir, origins = ['https://dah-workspace.vercel.app'], now, ports = [0], backend = 'file' } = {}) {
  const d = dir || (await tempDir())
  const env = { DAH_CONNECT_DEV_ISSUER: fake.url, DAH_CONNECT_DEV_API_BASE: fake.apiBase, DAH_CONNECT_HOME: d, DAH_CONNECT_STORE: 'file' }
  const app = await createApp({ env, dir: d, origins, now, ports, backend })
  app.dir = d
  opened.push(app)
  return app
}

export async function loginOk(app, fake, opts = {}) {
  return app.oauth.login({ openBrowser: (url) => fake.fakeBrowser(url), preferredPort: 0, ...opts })
}

/** 서버를 켜고 짝짓기까지 마친 상태 */
export async function pairedServer(app, origin = 'https://dah-workspace.vercel.app') {
  const port = await app.server.listen([0])
  const c = app.pairing.issue()
  const base = `http://127.0.0.1:${port}`
  const r = await fetch(`${base}/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: c.code }) })
  const { secret } = await r.json()
  return { port, base, secret, origin, auth: { authorization: `Bearer ${secret}`, origin } }
}

/** SSE 본문을 이벤트 배열로 */
export async function readSse(res) {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((b) => b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean)
    .map((d) => JSON.parse(d))
}
