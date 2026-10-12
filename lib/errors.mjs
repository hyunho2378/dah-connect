// DAH Connect: 오류 종류와 한국어 문구.
// 코드는 웹 화면이 알아보는 값이다(client/src/components/ai/localConnector.js 와 맞춘다).
//   UNAUTHORIZED  짝짓기 비밀값이 없거나 틀림        -> 화면에서 연결 코드를 다시 입력
//   NOT_LOGGED_IN 이 컴퓨터에서 ChatGPT 로그인이 안 됨 -> 터미널에서 login
//   RECONNECT     로그인이 끊김(철회·만료)           -> 터미널에서 login
//   PLAN_DISABLED 로그인했지만 요금제 사용을 허용하지 않음
//   PLAN_LIMIT    ChatGPT 요금제 또는 이 앱의 사용 한도
//   NOT_ELIGIBLE  이 계정·워크스페이스는 요금제 사용 불가
//   UNSUPPORTED   이 방식에서 지원하지 않는 기능·모델
//   RATE_LIMIT    잠시 뒤 다시 (연결 프로그램 쪽 제한)
//   UPSTREAM      OpenAI 쪽 일시 오류, BAD_REQUEST, TOO_LARGE, BUSY
import { USAGE_URL } from './config.mjs'

export class ConnectError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ConnectError'
    this.code = code
    this.status = extra.status ?? 502
    if (extra.requestId) this.requestId = extra.requestId
    if (extra.param) this.param = extra.param
    if (extra.link) this.link = extra.link
    if (extra.upstreamStatus) this.upstreamStatus = extra.upstreamStatus
    if (extra.upstreamCode) this.upstreamCode = extra.upstreamCode
  }
}

/** 로그나 화면으로 나가는 문장에서 토큰처럼 보이는 조각을 지운다 */
export function scrub(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[\w\-.~+/=]{8,}/gi, 'Bearer [가림]')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[가림]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[가림]')
}

const MSG = {
  subscription_sharing_usage_limit_exceeded: ['PLAN_LIMIT', 429, 'ChatGPT 사용 한도에 도달했습니다. 요금제 한도이거나 이 앱에 정한 한도일 수 있습니다. ChatGPT 설정의 사용량에서 확인하세요.'],
  subscription_sharing_usage_unavailable: ['UPSTREAM', 503, '사용량을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.'],
  subscription_sharing_user_not_eligible: ['NOT_ELIGIBLE', 403, '이 ChatGPT 계정이나 워크스페이스는 요금제 사용이 허용되지 않습니다. 같은 요청을 반복하지 마세요.'],
  subscription_sharing_unsupported_capability: ['UNSUPPORTED', 400, '이 방식에서 지원하지 않는 기능이나 모델입니다.'],
  subscription_sharing_route_not_supported: ['UPSTREAM', 403, '이 요청 경로는 요금제 사용에서 허용되지 않습니다.'],
  subscription_sharing_invalid_user: ['RECONNECT', 401, '로그인 정보를 확인하지 못했습니다. 연결 프로그램에서 다시 로그인하세요.'],
  subscription_sharing_user_unavailable: ['UPSTREAM', 503, '계정 정보를 잠시 가져오지 못했습니다. 잠시 뒤 다시 시도하세요.'],
  chatpass_v2_scope_not_authorized: ['UPSTREAM', 403, '이 연결에는 요금제 사용 권한이 없습니다. 다시 로그인해 권한을 허용하세요.'],
  chatpass_v2_invalid_authorization_context: ['UPSTREAM', 403, '이 연결에는 요금제 사용 권한이 없습니다. 다시 로그인해 권한을 허용하세요.'],
}

/**
 * OpenAI 쪽 실패를 ConnectError 로. 문서(errors-and-recovery)의 코드표를 따른다.
 * 스트림이 열리기 전 실패는 {"error":{...}} 일 수도, {"detail":"..."} 일 수도 있다(detail 은 진단용 문장이지 기계가 읽을 코드가 아니다).
 */
export function fromUpstream({ status, code, param, message, detail, requestId }) {
  const known = MSG[code]
  const extra = { requestId, param, upstreamStatus: status, upstreamCode: code }
  if (known) return new ConnectError(known[0], known[2], { ...extra, status: known[1], link: known[0] === 'PLAN_LIMIT' ? USAGE_URL : undefined })
  const tail = scrub(message || detail || '').slice(0, 200)
  if (status === 401) return new ConnectError('RECONNECT', '로그인 정보를 받아들이지 않았습니다. 연결 프로그램에서 다시 로그인하세요.', { ...extra, status: 401 })
  if (status === 403) return new ConnectError('UPSTREAM', `요청이 정책이나 권한 때문에 거절되었습니다.${tail ? ` (${tail})` : ''}`, { ...extra, status: 403 })
  if (status === 429) return new ConnectError('PLAN_LIMIT', '사용 한도에 도달했습니다. ChatGPT 설정의 사용량에서 확인하세요.', { ...extra, status: 429, link: USAGE_URL })
  if (status === 503) return new ConnectError('UPSTREAM', '지금은 이 방식의 요청을 받을 수 없습니다. 잠시 뒤 다시 시도하세요.', { ...extra, status: 503 })
  if (status === 400) return new ConnectError('BAD_REQUEST', `요청을 처리하지 못했습니다.${tail ? ` (${tail})` : ''}`, { ...extra, status: 400 })
  if (status === 404) return new ConnectError('UPSTREAM', '모델이나 주소를 찾을 수 없습니다. 모델을 다시 고르세요.', { ...extra, status: 404 })
  return new ConnectError('UPSTREAM', `ChatGPT 서버가 응답하지 못했습니다.${tail ? ` (${tail})` : ''}`, { ...extra, status: 502 })
}

/** 응답 본문(JSON 또는 글)에서 code/param/message/detail 을 뽑는다 */
export function readErrorBody(raw) {
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    /* 글 */
  }
  if (!j) return { detail: scrub(String(raw || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200) }
  const e = j.error && typeof j.error === 'object' ? j.error : null
  return {
    code: e?.code || (typeof j.error === 'string' ? j.error : undefined) || j.code,
    param: e?.param,
    message: e?.message || j.message,
    detail: typeof j.detail === 'string' ? j.detail : undefined,
  }
}
