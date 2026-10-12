// 로컬 서버: 짝짓기, 모델 목록, 채팅(SSE, 도구 호출, 이미지), 오류 처리. 가짜 OpenAI 를 상대로 한다.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { buildBody, parseChatBody, pickModels, toInput } from '../lib/responses.mjs'
import { closeApps, createFake, loginOk, makeApp, pairedServer, readSse } from './helpers.mjs'

let fake
before(async () => {
  fake = await createFake()
})
after(async () => {
  await closeApps()
  await fake.close()
})

async function ready(opts) {
  fake.state.mode = 'ok'
  fake.state.refreshFails = null
  fake.state.responsesMode = {}
  fake.state.requests.length = 0
  fake.state.tokenLifetime = 3600
  const app = await makeApp(fake, opts)
  await loginOk(app, fake)
  const p = await pairedServer(app)
  return { app, ...p }
}
const post = (c, path, body, headers = {}) => fetch(`${c.base}${path}`, { method: 'POST', headers: { ...c.auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const chat = (c, body) => post(c, '/chat', { model: 'gpt-fake-1', messages: [{ role: 'user', content: '안녕' }], ...body })

test('짝짓기 전 /status 는 최소 정보만, 짝짓기 후에는 로그인 상태·제한·요금제 안내', async () => {
  const c = await ready()
  const anon = await (await fetch(`${c.base}/status`, { headers: { origin: c.origin } })).json()
  assert.deepEqual(Object.keys(anon).sort(), ['app', 'installId', 'ok', 'paired', 'version'])
  assert.equal(anon.paired, false)
  const s = await (await fetch(`${c.base}/status`, { headers: c.auth })).json()
  assert.equal(s.paired, true)
  assert.equal(s.state, 'ready')
  assert.equal(s.planUsage, true)
  assert.equal(s.account.email, 'al***@example.com') // 이메일은 가려서 보인다
  assert.ok(s.limitations.ignoredSettings.includes('maxTokens'))
  assert.equal(s.usageUrl, 'https://chatgpt.com/settings/usage')
  await c.app.server.close()
})

test('로그인 전 상태, 요금제 미허용 상태를 구분해 알린다', async () => {
  fake.state.mode = 'no_plan'
  const app = await makeApp(fake)
  const c0 = await pairedServer(app)
  let s = await (await fetch(`${c0.base}/status`, { headers: c0.auth })).json()
  assert.equal(s.state, 'not_logged_in')
  await loginOk(app, fake)
  s = await (await fetch(`${c0.base}/status`, { headers: c0.auth })).json()
  assert.equal(s.state, 'plan_disabled')
  assert.equal(s.planUsage, false)
  const r = await chat(c0, {})
  assert.equal(r.status, 409)
  assert.equal((await r.json()).code, 'PLAN_DISABLED')
  await app.server.close()
  fake.state.mode = 'ok'
})

test('모델 목록: visibility=list 만, 서버 순서 그대로, 계약 모양 {id,name}', async () => {
  const c = await ready()
  const r = await (await fetch(`${c.base}/models`, { headers: c.auth })).json()
  assert.deepEqual(r.models, [{ id: 'gpt-fake-1', name: 'GPT Fake 1' }, { id: 'gpt-fake-mini', name: 'GPT Fake Mini' }])
  assert.equal(r.suggested, 'gpt-fake-1')
  await c.app.server.close()
})

test('채팅: SSE 로 text 와 done(usage)을 순서대로 보낸다. store:false, stream:true, 금지 필드 없음', async () => {
  const c = await ready()
  const res = await chat(c, { system: '너는 도우미', maxTokens: 500, temperature: 0.2 })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const evs = await readSse(res)
  assert.ok(evs.filter((e) => e.type === 'text').length >= 2)
  assert.equal(evs.at(-1).type, 'done')
  assert.equal(evs.at(-1).stopReason, 'end')
  assert.deepEqual(evs.at(-1).usage, { inputTokens: 7, outputTokens: 3 })
  const sent = JSON.parse(fake.state.requests.filter((r) => r.path === '/v1/responses').at(-1).body)
  assert.equal(sent.store, false)
  assert.equal(sent.stream, true)
  assert.equal(sent.instructions, '너는 도우미')
  assert.equal('max_output_tokens' in sent, false) // 이 경로가 거절하는 필드는 보내지 않는다
  assert.equal('temperature' in sent, false)
  assert.ok(sent.input.every((i) => i.role !== 'system'))
  const up = fake.state.requests.filter((r) => r.path === '/v1/responses').at(-1)
  assert.match(up.headers.authorization, /^Bearer at_/)
  await c.app.server.close()
})

test('채팅: 도구 호출 -> tool_call 이벤트와 meta.output, 도구 결과를 붙여 다시 보내면 답한다', async () => {
  const c = await ready()
  const tools = [{ name: 'replace_text', description: '찾아 바꾸기', parameters: { type: 'object', properties: { find: { type: 'string' } } } }]
  const evs = await readSse(await chat(c, { tools }))
  const call = evs.find((e) => e.type === 'tool_call')
  assert.equal(call.id, 'call_1')
  assert.equal(call.name, 'replace_text')
  assert.deepEqual(call.args, { find: '잇', replace: '있' })
  const done = evs.at(-1)
  assert.equal(done.stopReason, 'tool_use')
  assert.ok(done.meta.output.some((i) => i.type === 'function_call'))
  assert.ok(done.meta.output.some((i) => i.type === 'reasoning' && i.encrypted_content))
  // 두 번째 차례: 보냈던 항목을 그대로 되돌리고 결과를 붙인다
  const second = await readSse(
    await chat(c, {
      tools,
      messages: [
        { role: 'user', content: '고쳐' },
        { role: 'assistant', content: '고칩니다. ', toolCalls: [{ id: 'call_1', name: 'replace_text', args: call.args }], meta: done.meta },
        { role: 'tool', toolCallId: 'call_1', toolName: 'replace_text', content: '{"changed":3}' },
      ],
    })
  )
  assert.match(second.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /도구 결과를 받았습니다: \{"changed":3\}/)
  const sent = JSON.parse(fake.state.requests.filter((r) => r.path === '/v1/responses').at(-1).body)
  assert.ok(sent.input.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1'))
  assert.ok(sent.input.some((i) => i.type === 'reasoning'))
  await c.app.server.close()
})

test('채팅: 이미지(data URL)는 input_image 로 가고, 일반 URL 은 걸러진다', async () => {
  const c = await ready()
  const png = 'data:image/png;base64,iVBORw0KGgo='
  await readSse(await chat(c, { messages: [{ role: 'user', content: '이 그림', images: [png, 'https://evil.example/x.png', 'data:text/html;base64,AAAA'] }] }))
  const sent = JSON.parse(fake.state.requests.filter((r) => r.path === '/v1/responses').at(-1).body)
  const imgs = sent.input[0].content.filter((p) => p.type === 'input_image')
  assert.deepEqual(imgs, [{ type: 'input_image', image_url: png }])
  await c.app.server.close()
})

test('오류: 요금제 한도(429)는 스트림 전이면 JSON PLAN_LIMIT + 사용량 링크', async () => {
  const c = await ready()
  fake.state.responsesMode['gpt-fake-1'] = 'limit'
  const r = await chat(c, {})
  assert.equal(r.status, 429)
  const j = await r.json()
  assert.equal(j.code, 'PLAN_LIMIT')
  assert.equal(j.link, 'https://chatgpt.com/settings/usage')
  assert.match(j.error, /사용 한도/)
  await c.app.server.close()
})

test('오류: 스트림 도중 response.failed(한도)도 같은 형태로, 첫 이벤트가 오류면 JSON', async () => {
  const c = await ready()
  fake.state.responsesMode['gpt-fake-1'] = 'limit-stream'
  const r = await chat(c, {})
  assert.equal(r.status, 429)
  assert.equal((await r.json()).code, 'PLAN_LIMIT')
  await c.app.server.close()
})

test('오류: 자격 없음(403), 지원하지 않는 모델(400, param), {detail} 형태 503, 중간에 끊김', async () => {
  const c = await ready()
  fake.state.responsesMode = { 'gpt-fake-1': 'ineligible', a: 'unsupported', b: 'detail503', c: 'cut', d: 'incomplete' }
  let r = await chat(c, {})
  assert.equal((await r.json()).code, 'NOT_ELIGIBLE')
  r = await chat(c, { model: 'a' })
  let j = await r.json()
  assert.equal(r.status, 400)
  assert.equal(j.code, 'UNSUPPORTED')
  assert.equal(j.param, 'model')
  r = await chat(c, { model: 'b' })
  assert.equal(r.status, 503)
  assert.equal((await r.json()).code, 'UPSTREAM')
  // 글이 흐른 뒤 끊기면 error 이벤트
  const evs = await readSse(await chat(c, { model: 'c' }))
  assert.equal(evs[0].type, 'text')
  assert.equal(evs.at(-1).type, 'error')
  assert.match(evs.at(-1).message, /끊겼/)
  // 길이 제한으로 끝난 응답은 done length
  const inc = await readSse(await chat(c, { model: 'd' }))
  assert.equal(inc.at(-1).stopReason, 'length')
  await c.app.server.close()
})

test('만료된 토큰: 요청 전에 자동 갱신하고, 서버가 401 이면 한 번 더 강제 갱신한다', async () => {
  const c = await ready()
  const c0 = await c.app.store.readCredentials()
  await c.app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  let evs = await readSse(await chat(c, {}))
  assert.equal(evs.at(-1).type, 'done')
  const c1 = await c.app.store.readCredentials()
  assert.notEqual(c1.access_token, c0.access_token)
  // 서버 쪽에서만 만료된 경우(로컬 시계는 아직 유효)
  fake.expireAllAccess()
  fake.state.access.set(c1.access_token, { client_id: c1.client_id, sub: c1.subject, exp: Date.now() - 1 })
  evs = await readSse(await chat(c, {}))
  assert.equal(evs.at(-1).type, 'done')
  assert.notEqual((await c.app.store.readCredentials()).access_token, c1.access_token)
  await c.app.server.close()
})

test('로그인이 철회된 상태: 채팅은 401 RECONNECT, 상태는 reconnect', async () => {
  const c = await ready()
  const c0 = await c.app.store.readCredentials()
  for (const r of fake.state.refresh.values()) r.revoked = true
  await c.app.store.writeCredentials({ ...c0, expires_at: Date.now() - 1000 })
  const r = await chat(c, {})
  assert.equal(r.status, 401)
  assert.equal((await r.json()).code, 'RECONNECT')
  const s = await (await fetch(`${c.base}/status`, { headers: c.auth })).json()
  assert.equal(s.state, 'reconnect')
  await c.app.server.close()
})

test('요청 검사: 모델 없음, 잘못된 역할, 도구 이름, 본문이 JSON 아님', async () => {
  const c = await ready()
  assert.equal((await post(c, '/chat', { messages: [{ role: 'user', content: 'a' }] })).status, 400)
  assert.equal((await post(c, '/chat', { model: 'x', messages: [{ role: 'system', content: 'a' }] })).status, 400)
  assert.equal((await post(c, '/chat', { model: 'x', messages: [{ role: 'user', content: 'a' }], tools: [{ name: 'bad name!' }] })).status, 400)
  const r = await fetch(`${c.base}/chat`, { method: 'POST', headers: { ...c.auth, 'content-type': 'text/plain' }, body: '{}' })
  assert.equal(r.status, 415)
  await c.app.server.close()
})

test('도구 형식을 거절하면 네임스페이스로 묶어 한 번 더, include 를 거절하면 빼고 한 번 더', async () => {
  const c = await ready()
  fake.state.responsesMode = { rejectFlatTools: true, rejectInclude: true }
  const tools = [{ name: 'replace_text', description: 'd', parameters: { type: 'object', properties: {} } }]
  const evs = await readSse(await chat(c, { tools }))
  assert.equal(evs.find((e) => e.type === 'tool_call').name, 'replace_text')
  const sent = JSON.parse(fake.state.requests.filter((r) => r.path === '/v1/responses').at(-1).body)
  assert.equal(sent.tools[0].type, 'namespace')
  assert.equal('include' in sent, false)
  await c.app.server.close()
})

test('순수 함수: toInput, buildBody, pickModels, parseChatBody', () => {
  const input = toInput([
    { role: 'user', content: 'a', images: ['data:image/png;base64,AA=='] },
    { role: 'assistant', content: '답', toolCalls: [{ id: 'x.y', name: 't', args: { a: 1 } }] },
    { role: 'tool', toolCallId: 'x.y', content: '결과' },
  ])
  assert.deepEqual(input[0].content.map((p) => p.type), ['input_text', 'input_image'])
  assert.deepEqual(input[1], { role: 'assistant', content: '답' })
  assert.deepEqual(input[2], { type: 'function_call', call_id: 'x_y', name: 't', arguments: '{"a":1}' })
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'x_y', output: '결과' })
  const b = buildBody({ model: 'm', messages: [{ role: 'user', content: 'q' }], system: 's', tools: [] })
  for (const k of ['max_output_tokens', 'temperature', 'previous_response_id', 'metadata', 'user', 'truncation', 'top_p']) assert.equal(k in b, false)
  assert.equal(b.store, false)
  assert.equal(b.stream, true)
  assert.deepEqual(pickModels({ models: [{ slug: 'a', display_name: 'A', visibility: 'list' }, { slug: 'b', visibility: 'hide' }, { slug: 'c', visibility: 'list' }] }).models, [{ id: 'a', name: 'A' }, { id: 'c', name: 'c' }])
  assert.deepEqual(pickModels(null), { models: [], suggested: null })
  assert.throws(() => parseChatBody(null))
  const ok = parseChatBody({ model: 'gpt-x', messages: [{ role: 'user', content: 'a' }] })
  assert.equal(ok.model, 'gpt-x')
})
