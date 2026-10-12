// 브라우저에서 부르는 로컬 서버의 보안 시험: CORS, Origin/Host, Bearer, 연결 코드 잠금, 127.0.0.1 전용, 크기 한도, 기록 내용.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test, { after, before } from 'node:test'
import { hostAllowed, originAllowed } from '../lib/server.mjs'
import { closeApps, createFake, loginOk, makeApp, pairedServer } from './helpers.mjs'

let fake
before(async () => {
  fake = await createFake()
})
after(async () => {
  await closeApps()
  await fake.close()
})
const PROD = 'https://dah-workspace.vercel.app'

async function setup(opts) {
  const logs = []
  const app = await makeApp(fake, opts)
  await loginOk(app, fake)
  return { app, logs }
}

/** 임의의 Host 헤더로 보내는 원시 요청 */
function raw({ port, method = 'GET', path = '/status', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const c = []
      res.on('data', (x) => c.push(x))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }))
    })
    rq.on('error', reject)
    if (body) rq.write(body)
    rq.end()
  })
}

test('허용 목록: 운영 사이트만, 포트 와일드카드는 명시한 경우만', () => {
  const list = [PROD, 'http://localhost:*']
  assert.equal(originAllowed(PROD, list), true)
  assert.equal(originAllowed('http://localhost:5173', list), true)
  assert.equal(originAllowed('http://localhost', list), false)
  assert.equal(originAllowed('https://localhost:5173', list), false)
  assert.equal(originAllowed('http://127.0.0.1:5173', list), false)
  for (const bad of ['https://dah-workspace.vercel.app.evil.com', 'https://evil.com', 'null', 'https://dah-workspace.vercel.app/', 'http://dah-workspace.vercel.app', 'https://sub.dah-workspace.vercel.app', '', undefined]) assert.equal(originAllowed(bad, list), false, String(bad))
  assert.equal(originAllowed('http://localhost:5173', [PROD]), false) // 기본은 개발 서버 불허
  assert.equal(hostAllowed('127.0.0.1:47684', 47684), true)
  assert.equal(hostAllowed('localhost:47684', 47684), true)
  assert.equal(hostAllowed('evil.com:47684', 47684), false)
  assert.equal(hostAllowed('127.0.0.1', 47684), false)
})

test('CORS: 허용한 사이트만 헤더를 받고, 사전 요청에 Private Network 허락을 돌려준다', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  const pre = await fetch(`${c.base}/chat`, { method: 'OPTIONS', headers: { origin: PROD, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', 'access-control-request-private-network': 'true' } })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), PROD)
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true')
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/)
  assert.equal(pre.headers.get('vary'), 'Origin')
  // 요청이 없으면 Private Network 헤더도 없다
  const plain = await fetch(`${c.base}/chat`, { method: 'OPTIONS', headers: { origin: PROD, 'access-control-request-method': 'POST' } })
  assert.equal(plain.headers.get('access-control-allow-private-network'), null)
  // 낯선 사이트: 사전 요청도 실제 요청도 403, CORS 헤더 없음
  for (const evil of ['https://evil.com', 'null', 'https://dah-workspace.vercel.app.evil.com', 'http://localhost:5173']) {
    const p = await fetch(`${c.base}/status`, { method: 'OPTIONS', headers: { origin: evil, 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } })
    assert.equal(p.status, 403, evil)
    assert.equal(p.headers.get('access-control-allow-origin'), null)
    const g = await fetch(`${c.base}/status`, { headers: { origin: evil, authorization: `Bearer ${c.secret}` } })
    assert.equal(g.status, 403, evil)
    assert.equal(g.headers.get('access-control-allow-origin'), null)
    const m = await fetch(`${c.base}/models`, { headers: { origin: evil, authorization: `Bearer ${c.secret}` } })
    assert.equal(m.status, 403)
  }
  await app.server.close()
})

test('개발 출처는 설정했을 때만 허용된다', async () => {
  const { app } = await setup({ origins: [PROD, 'http://localhost:*'] })
  const c = await pairedServer(app)
  const r = await fetch(`${c.base}/status`, { headers: { origin: 'http://localhost:5601', authorization: `Bearer ${c.secret}` } })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5601')
  await app.server.close()
})

test('Bearer: 없으면 401, 틀리면 401, 형식이 이상해도 401. /status 는 틀린 비밀값을 401 로 알린다', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  for (const path of ['/models']) {
    assert.equal((await fetch(`${c.base}${path}`, { headers: { origin: PROD } })).status, 401)
    assert.equal((await fetch(`${c.base}${path}`, { headers: { origin: PROD, authorization: 'Bearer ' + 'a'.repeat(43) } })).status, 401)
    assert.equal((await fetch(`${c.base}${path}`, { headers: { origin: PROD, authorization: 'Bearer short' } })).status, 401)
    assert.equal((await fetch(`${c.base}${path}`, { headers: { origin: PROD, authorization: `Basic ${c.secret}` } })).status, 401)
  }
  const chat = await fetch(`${c.base}/chat`, { method: 'POST', headers: { origin: PROD, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'a' }] }) })
  assert.equal(chat.status, 401)
  assert.equal(fake.state.requests.filter((r) => r.path === '/v1/responses').length, 0) // OpenAI 쪽으로는 아무것도 가지 않았다
  const bad = await fetch(`${c.base}/status`, { headers: { origin: PROD, authorization: 'Bearer ' + 'b'.repeat(43) } })
  assert.equal(bad.status, 401)
  assert.equal((await bad.json()).code, 'UNAUTHORIZED')
  await app.server.close()
})

test('unpair 하면 그 비밀값은 더 못 쓴다', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  assert.equal((await fetch(`${c.base}/unpair`, { method: 'POST', headers: c.auth })).status, 200)
  assert.equal((await fetch(`${c.base}/models`, { headers: c.auth })).status, 401)
  await app.server.close()
})

test('Host 검사(DNS 리바인딩): 이상한 Host 는 올바른 비밀값이 있어도 403', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  for (const host of ['evil.com', `evil.com:${c.port}`, '127.0.0.1', `127.0.0.1.evil.com:${c.port}`, `0.0.0.0:${c.port}`]) {
    const r = await raw({ port: c.port, headers: { host, authorization: `Bearer ${c.secret}`, origin: PROD } })
    assert.equal(r.status, 403, host)
    assert.equal(JSON.parse(r.body).code, 'BAD_HOST')
  }
  const ok = await raw({ port: c.port, headers: { host: `localhost:${c.port}`, authorization: `Bearer ${c.secret}`, origin: PROD } })
  assert.equal(ok.status, 200)
  await app.server.close()
})

test('연결 코드: 6자리, 한 번만 쓸 수 있고, 맞으면 무작위 비밀값(43자)과 installId 를 준다', async () => {
  const { app } = await setup()
  const port = await app.server.listen([0])
  const base = `http://127.0.0.1:${port}`
  const c = app.pairing.issue()
  assert.match(c.code, /^\d{6}$/)
  const pair = (code) => fetch(`${base}/pair`, { method: 'POST', headers: { origin: PROD, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  const r = await pair(c.code)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.match(j.secret, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(j.installId)
  // 같은 코드 재사용 불가
  const again = await pair(c.code)
  assert.equal(again.status, 401)
  // 저장된 것은 해시뿐이다
  const stored = await (await import('node:fs/promises')).readFile(`${app.dir}/pairs.json`, 'utf8')
  assert.equal(stored.includes(j.secret), false)
  await app.server.close()
})

test('연결 코드 무차별 대입: 다섯 번 틀리면 코드가 사라지고 잠긴다(맞는 코드도 거절)', async () => {
  let t = Date.now()
  const { app } = await setup({ now: () => t })
  const port = await app.server.listen([0])
  const base = `http://127.0.0.1:${port}`
  const c = app.pairing.issue()
  const wrong = c.code === '000000' ? '111111' : '000000'
  const pair = (code) => fetch(`${base}/pair`, { method: 'POST', headers: { origin: PROD, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  for (let i = 0; i < 4; i++) {
    const r = await pair(wrong)
    assert.equal(r.status, 401)
    assert.equal((await r.json()).attemptsLeft, 4 - i)
  }
  const fifth = await pair(wrong)
  assert.equal(fifth.status, 429)
  assert.equal((await fifth.json()).code, 'PAIR_LOCKED')
  const right = await pair(c.code) // 잠금 중에는 맞는 코드도 안 된다
  assert.equal(right.status, 429)
  assert.ok(right.headers.get('retry-after'))
  assert.equal(app.pairing.issue(), null) // 잠금 중에는 새 코드를 만들지 않는다
  t += 5 * 60 * 1000 + 1
  const fresh = app.pairing.issue()
  assert.ok(fresh) // 잠금이 풀리면 새 코드
  assert.equal((await pair(c.code === fresh.code ? 'x' : c.code)).status, 401) // 예전 코드는 폐기됨
  assert.equal((await pair(fresh.code)).status, 200)
  await app.server.close()
})

test('연결 코드는 만료된다(15분)', async () => {
  let t = Date.now()
  const { app } = await setup({ now: () => t })
  const port = await app.server.listen([0])
  const c = app.pairing.issue()
  t += 16 * 60 * 1000
  const r = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { origin: PROD, 'content-type': 'application/json' }, body: JSON.stringify({ code: c.code }) })
  assert.equal(r.status, 401)
  assert.equal((await r.json()).code, 'BAD_CODE')
  await app.server.close()
})

test('127.0.0.1 에만 묶인다(0.0.0.0 아님), 다른 인터페이스 주소로는 접속되지 않는다', async () => {
  const { app } = await setup()
  const port = await app.server.listen([0])
  const addr = app.server.server.address()
  assert.equal(addr.address, '127.0.0.1')
  assert.equal(addr.family, 'IPv4')
  // 이 컴퓨터의 다른 IPv4 주소(있다면)로는 연결이 거절돼야 한다
  const os = await import('node:os')
  const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
  for (const ip of others.slice(0, 2)) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: ip, port, timeout: 1500 }, () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
      s.on('timeout', () => { s.destroy(); resolve(false) })
    })
    assert.equal(ok, false, `${ip} 로 접속되면 안 된다`)
  }
  await app.server.close()
})

test('listen 은 호스트 인자를 받지 않고 127.0.0.1 로 고정(소스 검사)', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../lib/server.mjs', import.meta.url), 'utf8')
  const calls = src.match(/\.listen\([^)]*\)/g) || []
  assert.ok(calls.length >= 1)
  assert.ok(calls.every((c) => c.includes("'127.0.0.1'") || c === '.listen(candidates = ports)'), calls.join(' | '))
  assert.equal(/0\.0\.0\.0|'::'|"::"/.test(src.replace(/\/\/.*$/gm, '')), false)
})

test('본문 크기 한도: /pair 2KB, /chat 3MB 를 넘으면 413', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  const big = await fetch(`${c.base}/pair`, { method: 'POST', headers: { origin: PROD, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(5000) }) })
  assert.equal(big.status, 413)
  const huge = await fetch(`${c.base}/chat`, { method: 'POST', headers: { ...c.auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'a'.repeat(3.2 * 1024 * 1024) }] }) })
  assert.equal(huge.status, 413)
  assert.equal((await huge.json()).code, 'TOO_LARGE')
  assert.equal(fake.state.requests.filter((r) => r.path === '/v1/responses').length, 0)
  await app.server.close()
})

test('채팅은 application/json 만 받는다(사전 요청 없이 보낼 수 있는 form/text 요청 차단)', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const r = await fetch(`${c.base}/chat`, { method: 'POST', headers: { ...c.auth, 'content-type': type }, body: '{}' })
    assert.equal(r.status, 415, type)
  }
  await app.server.close()
})

test('기록(log)에는 프롬프트·토큰·비밀값이 없다', async () => {
  const logs = []
  const app = await makeApp(fake)
  // log 를 받는 앱으로 다시 만든다
  const { createApp } = await import('../lib/app.mjs')
  const app2 = await createApp({ env: { DAH_CONNECT_DEV_ISSUER: fake.url, DAH_CONNECT_DEV_API_BASE: fake.apiBase, DAH_CONNECT_HOME: app.dir }, dir: app.dir, backend: 'file', origins: [PROD], ports: [0], log: (m) => logs.push(m) })
  await loginOk(app2, fake)
  const c = await pairedServer(app2)
  const secretPrompt = '비밀프롬프트-UNIQUE-12345'
  const res = await fetch(`${c.base}/chat`, { method: 'POST', headers: { ...c.auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-fake-1', system: secretPrompt, messages: [{ role: 'user', content: secretPrompt }] }) })
  await res.text()
  const cred = await app2.store.readCredentials()
  const all = logs.join('\n')
  assert.ok(logs.length > 0)
  for (const s of [secretPrompt, cred.access_token, cred.refresh_token, cred.id_token, c.secret]) assert.equal(all.includes(s), false)
  assert.match(all, /POST \/chat -> 200/)
  await app2.server.close()
})

test('오류 응답에도 토큰이 새지 않는다', async () => {
  const { app } = await setup()
  const c = await pairedServer(app)
  const cred = await app.store.readCredentials()
  fake.state.responsesMode = { leak: 'detail503' }
  const r = await fetch(`${c.base}/chat`, { method: 'POST', headers: { ...c.auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'leak', messages: [{ role: 'user', content: 'a' }] }) })
  const text = await r.text()
  for (const s of [cred.access_token, cred.refresh_token, cred.id_token]) assert.equal(text.includes(s), false)
  await app.server.close()
})
