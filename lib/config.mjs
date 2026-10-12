// DAH Connect: 상수와 설정.
// 아래 주소·범위·값은 모두 OpenAI "Sign in with ChatGPT" (ChatGPT plan usage, 오픈소스 앱) 문서에 적힌 것이다.
//   https://developers.openai.com/siwc/token-sharing-open-source
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//   https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//   https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//   https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
import os from 'node:os'
import path from 'node:path'

export const VERSION = '0.1.0'
export const APP_NAME = 'DAH Connect' // agent_name_hint: 앱의 실제 이름을 설치마다 똑같이 쓴다
export const REPO_URL = 'https://github.com/hyunho2378/dah-connect'
export const USER_AGENT = `DAH-Connect/${VERSION} (+${REPO_URL})` // 솔직한 사용자 에이전트. 다른 프로그램을 흉내 내지 않는다

export const DEFAULT_ISSUER = 'https://auth.openai.com'
// 문서의 예시 값. 실제 값은 discovery 문서(.well-known/openid-configuration)에서 읽고, 읽지 못하면 이 값을 쓴다.
export const DOC_ENDPOINTS = {
  issuer: DEFAULT_ISSUER,
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
}
export const DEFAULT_API_BASE = 'https://api.openai.com/v1' // resource 값이자 모델 목록·Responses 주소의 기준
export const RESOURCE = DEFAULT_API_BASE
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CALLBACK_PATH = '/auth/callback'
export const DOC_CALLBACK_PORT = 1455 // 문서 예시(http://127.0.0.1:1455/auth/callback). 사용 중이면 빈 포트를 쓴다

export const USAGE_URL = 'https://chatgpt.com/settings/usage'
export const HELP_URL = 'https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites'

// 웹 화면이 찾는 로컬 주소. 포트가 사용 중이면 다음 포트를 쓴다(화면이 순서대로 찾아본다).
export const SERVE_PORTS = [47684, 47685, 47686, 47687, 47688]
export const DEFAULT_ORIGINS = ['https://dah-workspace.vercel.app']
export const DEV_ORIGINS = ['http://localhost:*', 'http://127.0.0.1:*']

export const MAX_BODY_BYTES = 3 * 1024 * 1024 // /chat 요청 본문 한도(화면은 약 480KB 글자 이하로 보낸다)
export const MAX_PAIR_BODY_BYTES = 2048
export const MAX_CONCURRENT_CHATS = 4
export const PAIR_MAX_FAILS = 5
export const PAIR_LOCK_MS = 5 * 60 * 1000
export const PAIR_CODE_TTL_MS = 15 * 60 * 1000

// 개발·시험용 서버 주소 바꾸기는 루프백(http://127.0.0.1) 주소만 허용한다. 운영 주소로는 바꿀 수 없다.
export function devOverrides(env = process.env) {
  const ok = (v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') ? v.replace(/\/$/, '') : null
    } catch {
      return null
    }
  }
  return {
    issuer: ok(env.DAH_CONNECT_DEV_ISSUER || '') || null,
    apiBase: ok(env.DAH_CONNECT_DEV_API_BASE || '') || null,
  }
}

export function configDir(env = process.env, platform = process.platform) {
  if (env.DAH_CONNECT_HOME) return env.DAH_CONNECT_HOME
  const home = os.homedir()
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'DAH Connect')
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'DAH Connect')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'dah-connect')
}
