#!/usr/bin/env node
// DAH Connect: 내 ChatGPT 요금제를 디인예 워크스페이스 AI 창에서 쓰게 해 주는 작은 프로그램.
//   node dah-connect.mjs start      로그인(필요하면) 후 연결 서버를 켠다 (처음 쓸 때 권장)
//   node dah-connect.mjs login      ChatGPT 로그인 (브라우저가 열린다)
//   node dah-connect.mjs serve      연결 서버만 켠다 (127.0.0.1 전용)
//   node dah-connect.mjs status     로그인·저장 상태 보기
//   node dah-connect.mjs logout     로그인 정보 지우기 (--forget 이면 등록 정보까지)
// 자세한 설명: README.md
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createApp, originsFrom } from './lib/app.mjs'
import { APP_NAME, HELP_URL, USAGE_URL, VERSION } from './lib/config.mjs'
import { ConnectError } from './lib/errors.mjs'

const out = (s = '') => process.stdout.write(`${s}\n`)
const warn = (s = '') => process.stderr.write(`${s}\n`)
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)

function parseArgs(argv) {
  const a = { _: [], origin: [] }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '--dev') a.dev = true
    else if (v === '--no-open') a.noOpen = true
    else if (v === '--reconsent') a.reconsent = true
    else if (v === '--forget') a.forget = true
    else if (v === '--file-store') a.fileStore = true
    else if (v === '--origin') a.origin.push(argv[++i] || '')
    else if (v.startsWith('--origin=')) a.origin.push(v.slice(9))
    else if (v === '-h' || v === '--help') a._.unshift('help')
    else a._.push(v)
  }
  return a
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
      p.on('error', () => resolve(false))
      p.unref()
      setTimeout(() => resolve(true), 300)
    } catch {
      resolve(false)
    }
  })
}

function help() {
  out(`${bold(`${APP_NAME} ${VERSION}`)}  내 ChatGPT 요금제를 디인예 워크스페이스 AI 창에서 쓰게 해 주는 프로그램

사용법: node dah-connect.mjs <명령>

  start     로그인(필요하면) 후 연결 서버를 켭니다. 처음에는 이것만 쓰면 됩니다.
  login     ChatGPT 로그인 (브라우저가 열립니다)
            --reconsent  요금제 사용 허용 화면을 다시 띄웁니다
  serve     연결 서버만 켭니다 (이 컴퓨터 안에서만 접속 가능)
            --dev        http://localhost:* 에서 열린 개발 서버도 허용
            --origin <주소>  허용할 사이트를 더합니다 (여러 번 가능)
  status    로그인·저장 상태를 봅니다
  logout    로그인 정보를 지웁니다 (ChatGPT 쪽 갱신 토큰도 철회합니다)
            --forget     등록 정보와 짝짓기 정보까지 지웁니다

도움말: ${HELP_URL}`)
}

async function build(args) {
  const env = { ...process.env }
  if (args.fileStore) env.DAH_CONNECT_STORE = 'file'
  const origins = originsFrom({ env, extra: args.origin.filter(Boolean), dev: args.dev })
  return createApp({ env, origins, log: args._[0] === 'serve' || args._[0] === 'start' ? (m) => out(`  ${m}`) : undefined })
}

async function ask(prompt) {
  if (!process.stdin.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((r) => rl.question(prompt, (v) => { rl.close(); r(v) }))
}

function showPlanNotice() {
  out('')
  out(bold('ChatGPT 요금제를 사용 중입니다'))
  out('  이 프로그램을 통한 AI 요청은 내 ChatGPT 요금제(또는 크레딧) 사용량으로 계산됩니다.')
  out('  이 앱에 따로 한도를 정하거나 사용량을 확인하려면 ChatGPT 설정의 사용량 화면을 여세요.')
  out(`  ${USAGE_URL}`)
  out('  Plus 요금제는 5시간 사용 한도를 다른 앱과 함께 씁니다. Pro 요금제에는 5시간 한도가 없습니다.')
  out('')
}

async function cmdLogin(app, args) {
  out(`${APP_NAME} 로그인을 시작합니다. 브라우저가 열리면 ChatGPT 에 로그인하고, 요금제 사용을 허용할지 고르세요.`)
  out('이 컴퓨터 이름이나 파일, ChatGPT 대화 내용은 이 프로그램에 전달되지 않습니다. 허용하는 것은 "내 요금제로 AI 요청을 보내는 것"뿐입니다.')
  let r
  try {
    r = await app.oauth.login({
      reconsent: args.reconsent,
      onAuthUrl: (shown) => {
        if (args.noOpen) out(`\n아래 주소를 브라우저에 붙여 넣어 여세요:\n${shown}\n`)
      },
      openBrowser: async (full, shown) => {
        if (args.noOpen) return
        const ok = await openBrowser(full)
        if (!ok) out(`\n브라우저를 열지 못했습니다. 아래 주소를 직접 여세요:\n${shown}\n`)
        else out('브라우저에서 로그인을 마칠 때까지 기다립니다 (5분)...')
      },
    })
  } catch (e) {
    if (e instanceof ConnectError) {
      warn(`\n로그인하지 못했습니다: ${e.message}`)
      return 1
    }
    throw e
  }
  if (r.status === 'declined') {
    out('\n요금제 사용을 허용하지 않아 연결하지 않았습니다.')
    out('다시 시도하려면: node dah-connect.mjs login --reconsent')
    out('API 키로 쓰고 싶다면 워크스페이스 AI 설정에서 API 키 방식을 고르세요.')
    return 2
  }
  if (r.status === 'no_plan_scope') {
    out('\n로그인은 되었지만 요금제 사용 권한이 빠져 있어 AI 요청은 보내지 않습니다.')
    out('다시 로그인해 허용하려면: node dah-connect.mjs login --reconsent')
    return 2
  }
  out(`\n로그인했습니다${r.account.email ? ` (${r.account.email})` : ''}.`)
  if (r.firstTime) {
    showPlanNotice()
    if (process.stdin.isTTY) await ask('확인했으면 Enter 를 누르세요 (Got it): ')
    await app.oauth.markWelcomed()
  }
  return 0
}

async function cmdServe(app) {
  const reg = await app.store.readRegistration()
  const cred = await app.store.readCredentials().catch(() => null)
  if (!cred?.access_token) {
    warn('아직 ChatGPT 로그인이 안 되어 있습니다. 서버는 켜지만 AI 요청은 로그인 후에 됩니다.')
    warn('다른 터미널에서: node dah-connect.mjs login')
  } else if (reg?.planUsage === false) {
    warn('로그인은 되어 있지만 요금제 사용을 허용하지 않았습니다. node dah-connect.mjs login --reconsent')
  }
  const port = await app.server.listen()
  const printCode = () => {
    const c = app.pairing.issue()
    if (!c) {
      out(`  연결 코드를 틀린 횟수가 많아 ${Math.ceil(app.pairing.lockedMs / 60000)}분 동안 잠겨 있습니다.`)
      return
    }
    out('')
    out(`  연결 코드: ${bold(`${c.code.slice(0, 3)} ${c.code.slice(3)}`)}   (15분 동안 한 번만 쓸 수 있습니다)`)
    out('  워크스페이스 AI 설정에서 "내 컴퓨터의 ChatGPT 연결"을 고르고 이 코드를 입력하세요.')
    out('')
  }
  out('')
  out(bold(`${APP_NAME} 연결 서버가 켜졌습니다`))
  out(`  주소: http://127.0.0.1:${port}  (이 컴퓨터 안에서만 접속됩니다)`)
  out(`  허용한 사이트: ${app.server.allowList.join(', ')}`)
  printCode()
  out('  새 연결 코드가 필요하면 Enter, 끝내려면 Ctrl+C 를 누르세요.')
  if (process.stdin.isTTY) {
    readline.createInterface({ input: process.stdin }).on('line', () => printCode())
  }
  await new Promise((resolve) => {
    const stop = async () => {
      out('\n종료합니다.')
      await app.server.close()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

async function cmdStatus(app) {
  const reg = await app.store.readRegistration()
  let cred = null
  let err = ''
  try {
    cred = await app.store.readCredentials()
  } catch (e) {
    err = e.message
  }
  out(bold(`${APP_NAME} ${VERSION}`))
  out(`  저장 폴더: ${app.store.dir}`)
  out(`  이 컴퓨터 id: ${app.host.ext_agent_host_id}`)
  out(`  로그인: ${cred?.access_token ? `되어 있음${cred.email ? ` (${cred.email})` : ''}` : err || '안 되어 있음'}`)
  if (cred?.access_token) {
    out(`  요금제 사용 허용: ${cred.scopes?.includes('chatgpt.tokens.use.direct') ? '예' : '아니오'}`)
    out(`  저장 방식: ${app.store.mode === 'keychain' ? 'macOS 키체인 키로 암호화한 파일' : '소유자만 읽는 파일(0600)'}`)
    out(`  액세스 토큰 만료: ${cred.expires_at ? new Date(cred.expires_at).toLocaleString('ko-KR') : '알 수 없음'} (만료 전에 자동 갱신됩니다)`)
  }
  out(`  등록(client_id): ${reg?.client_id ? '있음' : '없음'}`)
  out(`  짝지은 브라우저: ${(await app.store.readPairs()).length}개`)
  out(`  사용량 관리: ${USAGE_URL}`)
  return 0
}

async function cmdLogout(app, args) {
  out('로그아웃합니다...')
  const r = await app.oauth.logout({ forget: args.forget })
  if (r.revoked === true) out('ChatGPT 쪽 갱신 토큰을 철회했고, 이 컴퓨터의 로그인 정보를 지웠습니다.')
  else if (r.revoked === false) {
    out('이 컴퓨터의 로그인 정보는 지웠지만, ChatGPT 쪽 철회는 확인하지 못했습니다.')
    out(`ChatGPT 설정 > 보안 및 로그인 > 로그인 연결(Login connections)에서 "${APP_NAME}"을 직접 연결 해제하세요.`)
  } else out('지울 로그인 정보가 없습니다.')
  if (args.forget) out('등록 정보와 짝짓기 정보도 지웠습니다.')
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'help'
  if (cmd === 'help') return help()
  if (cmd === 'version' || cmd === '--version') return out(VERSION)
  if (!['login', 'serve', 'start', 'status', 'logout'].includes(cmd)) {
    warn(`알 수 없는 명령입니다: ${cmd}`)
    help()
    process.exitCode = 1
    return
  }
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 20) {
    warn(`Node.js 20 이상이 필요합니다 (지금 ${process.versions.node}). https://nodejs.org 에서 설치하세요.`)
    process.exitCode = 1
    return
  }
  const app = await build(args)
  if (cmd === 'login') process.exitCode = await cmdLogin(app, args)
  else if (cmd === 'status') process.exitCode = await cmdStatus(app)
  else if (cmd === 'logout') process.exitCode = await cmdLogout(app, args)
  else if (cmd === 'serve') process.exitCode = await cmdServe(app)
  else if (cmd === 'start') {
    const cred = await app.store.readCredentials().catch(() => null)
    if (!cred?.access_token || !cred.scopes?.includes('chatgpt.tokens.use.direct')) {
      const code = await cmdLogin(app, args)
      if (code !== 0) {
        process.exitCode = code
        return
      }
    }
    process.exitCode = await cmdServe(app)
  }
}

main().catch((e) => {
  warn(`\n오류가 났습니다: ${e instanceof ConnectError ? e.message : e?.message || e}`)
  process.exitCode = 1
})
