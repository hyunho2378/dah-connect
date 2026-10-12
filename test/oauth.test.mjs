// 가짜 OpenAI(로컬)를 상대로 한 로그인·갱신·로그아웃 시험. 실제 OpenAI 를 부르지 않는다.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { closeApps, createFake, loginOk, makeApp } from './helpers.mjs'
import { parseTime } from '../lib/oauth.mjs'
import { peekPayload } from '../lib/jwt.mjs'

let fake
before(async () => {
  fake = await createFake()
})
after(async () => {
  await closeApps()
  await fake.close()
})
const reset = () => {
  fake.state.mode = 'ok'
  fake.state.refreshFails = null
  fake.state.requests.length = 0
  fake.state.authorizeQueries.length = 0
  fake.state.tokenLifetime = 3600
  fake.state.includeScopeInTokenResponse = true
}

test('첫 로그인: 동적 등록 요청 값, PKCE, 호스트 id, 자격 증명 저장', async () => {
  reset()
  const app = await makeApp(fake)
  const r = await loginOk(app, fake)
  assert.equal(r.status, 'ok')
  assert.equal(r.firstTime, true)
  assert.match(r.clientId, /^oaiapp_/)
  const q = fake.state.authorizeQueries[0]
  assert.equal(q.client_id, 'dynamic_agent_client')
  assert.equal(q.agent_name_hint, 'DAH Connect')
  assert.match(q.ext_agent_host_id, /^urn:uuid:[0-9a-f-]{36}$/)
  assert.equal(q.scope, 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
  assert.equal(q.resource, fake.apiBase)
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.response_type, 'code')
  assert.match(q.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  assert.ok(q.state.length >= 32 && q.nonce.length >= 32)
  assert.equal('id_token_hint' in q, false)

  const cred = await app.store.readCredentials()
  assert.equal(cred.client_id, r.clientId)
  assert.equal(cred.ext_agent_host_id, q.ext_agent_host_id)
  assert.ok(cred.scopes.includes('chatgpt.tokens.use.direct'))
  assert.equal(cred.token_type, 'Bearer')
  assert.equal(cred.expires_in, 3600)
  // 소유자만 읽는 파일(0600)
  const st = await fs.stat(path.join(app.dir, 'credentials.json'))
  assert.equal(st.mode & 0o777, 0o600)
  // 토큰 요청에 solid 한 값이 갔는지(코드 교환은 client_id=발급된 값)
  const tokenReq = fake.state.requests.find((x) => x.path === '/api/accounts/oauth/token')
  const p = new URLSearchParams(tokenReq.body)
  assert.equal(p.get('client_id'), r.clientId)
  assert.equal(p.get('resource'), fake.apiBase)
  assert.equal(p.has('client_secret'), false)
})

test('호스트 id 는 첫 로그인 전에 만들어져 있고 다시 로그인해도 같다', async () => {
  reset()
  const app = await makeApp(fake)
  const before = await app.store.readCredentials()
  assert.equal(before, null)
  const h1 = await fs.readFile(path.join(app.dir, 'host.json'), 'utf8') // makeApp 이 이미 만들어 둠
  await loginOk(app, fake)
  await loginOk(app, fake)
  const h2 = await fs.readFile(path.join(app.dir, 'host.json'), 'utf8')
  assert.equal(JSON.parse(h1).ext_agent_host_id, JSON.parse(h2).ext_agent_host_id)
  assert.equal(new Set(fake.state.authorizeQueries.map((q) => q.ext_agent_host_id)).size, 1)
})

test('다시 로그인: 저장된 client_id 재사용, agent_name_hint 생략, 힌트 전달, 새 클라이언트 안 만듦', async () => {
  reset()
  const app = await makeApp(fake)
  const first = await loginOk(app, fake)
  const second = await loginOk(app, fake)
  assert.equal(second.clientId, first.clientId)
  assert.equal(second.firstTime, true) // 환영 안내는 확인(markWelcomed) 전까지 첫 로그인으로 취급
  const q = fake.state.authorizeQueries.at(-1)
  assert.equal(q.client_id, first.clientId)
  assert.equal('agent_name_hint' in q, false)
  assert.ok(q.id_token_hint)
  assert.equal(q.login_hint, 'alice@example.com')
})

test('동의 거절(access_denied): 코드 교환 없이 끝, 토큰 저장 없음', async () => {
  reset()
  fake.state.mode = 'decline'
  const app = await makeApp(fake)
  const r = await loginOk(app, fake)
  assert.equal(r.status, 'declined')
  assert.equal(fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length, 0)
  assert.equal(await app.store.readCredentials(), null)
})

test('요금제 권한이 빠진 로그인: 로그인은 남기고 요금제 사용은 꺼 둔다, 추론 시도는 막힌다', async () => {
  reset()
  fake.state.mode = 'no_plan'
  const app = await makeApp(fake)
  const r = await loginOk(app, fake)
  assert.equal(r.status, 'no_plan_scope')
  const reg = await app.store.readRegistration()
  assert.equal(reg.planUsage, false)
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'PLAN_DISABLED')
  // 다시 로그인하면 prompt=consent 로 허용 화면을 다시 요청한다
  fake.state.mode = 'ok'
  const again = await loginOk(app, fake)
  assert.equal(again.status, 'ok')
  assert.equal(fake.state.authorizeQueries.at(-1).prompt, 'consent')
})

test('ID 토큰 nonce 가 틀리면 로그인을 거절하고 아무것도 저장하지 않는다', async () => {
  reset()
  fake.state.mode = 'bad_nonce'
  const app = await makeApp(fake)
  await assert.rejects(loginOk(app, fake), (e) => e.code === 'LOGIN_FAILED' && /ID 토큰/.test(e.message))
  assert.equal(await app.store.readCredentials(), null)
})

test('다른 계정으로 돌아오면 기존 자격 증명을 바꾸지 않는다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const before = (await app.store.readCredentials()).access_token
  fake.state.mode = 'other_account'
  await assert.rejects(loginOk(app, fake), (e) => /다른 계정/.test(e.message))
  assert.equal((await app.store.readCredentials()).access_token, before)
})

test('state 가 다른 콜백은 무시되고 올바른 콜백이 오면 이어진다', async () => {
  reset()
  const app = await makeApp(fake)
  let seenPort
  const r = await app.oauth.login({
    preferredPort: 0,
    openBrowser: async (url) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri'))
      seenPort = redirect.port
      const bad = await fetch(`${redirect.origin}/auth/callback?code=x&state=nope`)
      assert.equal(bad.status, 400)
      const wrongPath = await fetch(`${redirect.origin}/callback?code=x`)
      assert.equal(wrongPath.status, 404)
      await fake.fakeBrowser(url)
    },
  })
  assert.equal(r.status, 'ok')
  assert.ok(seenPort)
})

test('콜백 서버는 127.0.0.1 에만 묶인다', async () => {
  reset()
  const app = await makeApp(fake)
  await app.oauth.login({
    preferredPort: 0,
    openBrowser: async (url) => {
      const port = new URL(new URL(url).searchParams.get('redirect_uri')).port
      // 잘못된 Host 로는 열리지 않는다
      const status = await new Promise((resolve) => {
        const rq = http.request({ host: '127.0.0.1', port, path: '/auth/callback?code=1&state=1', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode) })
        rq.on('error', () => resolve(0))
        rq.end()
      })
      assert.equal(status, 403)
      await fake.fakeBrowser(url)
    },
  })
})

test('갱신: 만료 전에는 쓰던 토큰, 만료 임박하면 회전된 새 토큰으로 한 번에 교체', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  const a0 = await app.oauth.getAccess()
  assert.equal(a0.accessToken, c0.access_token) // 아직 갱신 안 함
  assert.equal(fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length, 1)

  // 만료 시각을 당긴다(earliest_refresh_at 도 지난 것으로)
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() + 60 * 1000, earliest_refresh_at: new Date(Date.now() - 1000).toISOString() })
  const a1 = await app.oauth.getAccess()
  assert.notEqual(a1.accessToken, c0.access_token)
  const c1 = await app.store.readCredentials()
  assert.notEqual(c1.refresh_token, c0.refresh_token) // 회전
  assert.equal(c1.access_token, a1.accessToken)
  const rt = fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').at(-1)
  const p = new URLSearchParams(rt.body)
  assert.equal(p.get('grant_type'), 'refresh_token')
  assert.equal(p.get('client_id'), c0.client_id) // dynamic_agent_client 가 아니다
  assert.equal(p.get('resource'), fake.apiBase)
  assert.equal(p.has('scope'), false)
})

test('earliest_refresh_at 전에는 만료가 가까워도 갱신하지 않는다(아직 만료 전일 때)', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() + 60 * 1000, earliest_refresh_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() })
  const a = await app.oauth.getAccess()
  assert.equal(a.accessToken, c0.access_token)
})

test('동시에 여러 요청이 와도 갱신은 한 번만(회전 토큰 경쟁 방지)', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  const before = fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length
  const res = await Promise.all([app.oauth.getAccess(), app.oauth.getAccess(), app.oauth.getAccess(), app.oauth.getAccess()])
  assert.equal(new Set(res.map((r) => r.accessToken)).size, 1)
  assert.equal(fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length - before, 1)
})

test('두 프로그램(별도 앱 객체)이 같은 폴더를 쓸 때도 잠금으로 한 번만 갱신', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  const app2 = await makeApp(fake, { dir: app.dir })
  const before = fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length
  const [a, b] = await Promise.all([app.oauth.getAccess(), app2.oauth.getAccess()])
  assert.equal(a.accessToken, b.accessToken)
  assert.equal(fake.state.requests.filter((x) => x.path === '/api/accounts/oauth/token').length - before, 1)
})

test('갱신 토큰이 철회되었으면(invalid_grant) 토큰을 지우고 RECONNECT, 등록 정보는 남긴다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  for (const r of fake.state.refresh.values()) r.revoked = true
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'RECONNECT')
  assert.equal(await app.store.readCredentials(), null)
  assert.ok((await app.store.readRegistration()).client_id)
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'NOT_LOGGED_IN')
})

test('refresh_token_reused 도 끊긴 로그인으로 처리한다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  fake.state.refresh.get(c0.refresh_token).used = true
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'RECONNECT')
})

test('일시 오류(5xx)에서는 토큰을 지우지 않는다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  fake.state.refreshFails = { status: 503, body: { error: 'temporarily_unavailable' } }
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'UPSTREAM')
  assert.equal((await app.store.readCredentials()).refresh_token, c0.refresh_token)
  fake.state.refreshFails = null
  assert.ok((await app.oauth.getAccess()).accessToken)
})

test('invalid_client 는 설정 오류로 알리고 토큰은 지우지 않는다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  fake.state.refreshFails = { status: 401, body: { error: 'invalid_client' } }
  await app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  await assert.rejects(app.oauth.getAccess(), (e) => e.code === 'UPSTREAM' && /클라이언트/.test(e.message))
  assert.ok(await app.store.readCredentials())
})

test('로그아웃: 갱신 토큰 철회 요청(token, hint, client_id)을 보내고 로컬 토큰을 지우되 등록·호스트 id 는 남긴다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const c0 = await app.store.readCredentials()
  const r = await app.oauth.logout()
  assert.equal(r.revoked, true)
  assert.deepEqual(fake.state.revoked.at(-1), { token: c0.refresh_token, hint: 'refresh_token', client_id: c0.client_id })
  assert.equal(await app.store.readCredentials(), null)
  assert.equal((await app.store.readRegistration()).client_id, c0.client_id)
  assert.ok(JSON.parse(await fs.readFile(path.join(app.dir, 'host.json'), 'utf8')).ext_agent_host_id)
  // 철회된 토큰은 더 못 쓴다
  assert.equal(fake.state.refresh.get(c0.refresh_token).revoked, true)
})

test('로그아웃: 철회를 확인하지 못해도 로컬은 지우고 그 사실을 알린다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  const realFetch = globalThis.fetch
  // 철회 주소만 실패하는 fetch 로 바꾼 앱
  const { createApp } = await import('../lib/app.mjs')
  const flaky = await createApp({
    env: { DAH_CONNECT_DEV_ISSUER: fake.url, DAH_CONNECT_DEV_API_BASE: fake.apiBase, DAH_CONNECT_HOME: app.dir },
    dir: app.dir,
    backend: 'file',
    fetchImpl: (u, i) => (String(u).includes('/revoke') ? Promise.reject(new Error('net')) : realFetch(u, i)),
    ports: [0],
  })
  const r = await flaky.oauth.logout({ sleepMs: async () => {} })
  assert.equal(r.revoked, false)
  assert.equal(await flaky.store.readCredentials(), null)
})

test('로그아웃 --forget 은 등록과 짝짓기 정보도 지운다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  await app.oauth.logout({ forget: true })
  assert.equal(await app.store.readRegistration(), null)
})

test('발신 요청의 User-Agent 는 DAH-Connect 로 솔직하고, 다른 프로그램을 흉내 내지 않는다', async () => {
  reset()
  const app = await makeApp(fake)
  await loginOk(app, fake)
  await app.responses.listModels()
  const fromConnector = fake.state.requests.filter((r) => r.path !== '/api/accounts/authorize') // authorize 는 시험용 가짜 브라우저가 부른다
  assert.ok(fromConnector.length >= 4)
  for (const r of fromConnector) {
    assert.match(r.headers['user-agent'], /^DAH-Connect\/\d/)
    assert.doesNotMatch(JSON.stringify(r.headers), /codex|chatgpt-desktop|openai-python|OpenAI\//i)
  }
  const authReq = fake.state.authorizeQueries[0]
  assert.doesNotMatch(JSON.stringify(authReq), /codex/i)
})

test('earliest_refresh_at 시간 형식(초, 밀리초, ISO)을 모두 읽는다', () => {
  assert.equal(parseTime(1790032532), 1790032532000)
  assert.equal(parseTime(1790032532000), 1790032532000)
  assert.equal(parseTime('2026-10-12T00:00:00Z'), Date.parse('2026-10-12T00:00:00Z'))
  assert.equal(parseTime(undefined), null)
  assert.equal(parseTime('nope'), null)
})

test('응답에 scope 가 없으면 콜백·액세스 토큰의 scope 로 판단한다', async () => {
  reset()
  fake.state.includeScopeInTokenResponse = false
  const app = await makeApp(fake)
  const r = await loginOk(app, fake)
  assert.equal(r.status, 'ok') // 콜백의 scope 값 사용
  assert.equal(peekPayload('a.b.c'), null)
})
