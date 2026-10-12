# DAH Connect

내 ChatGPT 요금제를 디인예 워크스페이스의 AI 창에서 쓰게 해 주는 작은 프로그램입니다. 내 컴퓨터에서만 돌고, 오픈소스(MIT)입니다.

OpenAI의 "Sign in with ChatGPT"에 있는 "ChatGPT plan usage"(요금제 사용) 기능을 문서가 정한 대로 씁니다. 공식 문서는 아래 "따른 문서"에 있습니다.

## 이 프로그램이 하는 일

- ChatGPT에 로그인하고, "이 프로그램이 내 요금제로 AI 요청을 보내는 것"을 허용합니다.
- 내 컴퓨터 안에서 작은 서버(주소 `127.0.0.1`, 이 컴퓨터 안에서만 접속됨)를 켭니다.
- 워크스페이스 AI 창이 이 서버에 요청을 보내면, 내 요금제로 ChatGPT에 전달하고 답을 돌려줍니다.

## 하지 않는 일

- Claude 구독은 지원하지 않습니다. Anthropic이 허용하지 않습니다. Claude는 워크스페이스에서 API 키로 연결하세요.
- ChatGPT 대화 기록, 파일, 다른 계정 정보를 읽지 않습니다. 허용한 것은 "내 요금제로 AI 요청 보내기"뿐입니다.
- 토큰(로그인 정보)을 우리 서버나 다른 곳으로 보내지 않습니다. 이 컴퓨터 밖으로 나가는 것은 OpenAI로 가는 요청뿐입니다.
- 프롬프트와 답변을 기록하지 않습니다. 터미널에는 "어떤 요청이 몇 번 처리됐다"만 나옵니다.
- OpenAI 문서에 없는 주소는 부르지 않습니다. 다른 프로그램(Codex 등)인 척하지 않고, 이름은 `DAH Connect`, 사용자 에이전트는 `DAH-Connect/버전`으로 솔직하게 밝힙니다.

## 설치 (처음 한 번)

1. Node.js 20 이상을 설치합니다. https://nodejs.org 에서 LTS를 받으면 됩니다. (이미 있으면 건너뜁니다. 터미널에서 `node -v`로 확인)
2. 이 폴더를 내려받아 원하는 곳에 둡니다.
3. macOS: `연결 프로그램 시작.command`를 더블클릭합니다.
   - "확인되지 않은 개발자" 경고가 나오면 파일을 우클릭 > 열기 > 열기를 한 번 누릅니다.
   - 다른 운영체제: 터미널에서 `node dah-connect.mjs start`
4. 브라우저가 열리면 ChatGPT에 로그인하고, "요금제 사용"을 허용할지 고릅니다. 처음에는 앱 이름(DAH Connect)을 확인하라는 화면이 나옵니다.
5. 터미널 창에 6자리 연결 코드가 나옵니다.
6. 워크스페이스 AI 창 설정에서 "내 컴퓨터의 ChatGPT 연결"을 고르고 코드를 입력합니다.
7. 모델을 고르면 끝입니다. 이후에는 `연결 프로그램 시작.command`만 켜 두면 됩니다. 로그인은 자동으로 유지됩니다(최대 30일, 쓰는 동안 계속 갱신).

연결 코드는 15분 동안 한 번만 쓸 수 있습니다. 새 코드가 필요하면 터미널 창에서 Enter를 누르세요. 코드를 5번 틀리면 5분 동안 잠깁니다.

## 브라우저 안내

- Chrome, Edge 권장입니다. Chrome 142부터는 공개 사이트가 내 컴퓨터의 프로그램에 접속하려 할 때 "이 기기의 앱에 접근" 허용을 묻습니다(Chrome 145부터 이름이 "기기 내 앱"). 허용해야 합니다. 거부했다면 주소창 왼쪽 자물쇠 > 사이트 설정에서 다시 허용하세요.
- Safari는 https 사이트에서 http://127.0.0.1 접속을 막을 수 있어 연결이 안 될 수 있습니다.
- 프로그램은 Chrome의 Private Network Access 사전 요청(`Access-Control-Request-Private-Network`)에 허락(`Access-Control-Allow-Private-Network: true`)으로 답합니다. 허용된 사이트에게만 해당합니다.

## 사용량과 한도

- AI 요청은 내 ChatGPT 요금제(또는 허용한 크레딧) 사용량으로 계산됩니다.
- ChatGPT Plus는 5시간 사용 한도를 요금제를 쓰는 모든 앱이 함께 씁니다. Pro에는 5시간 한도가 없습니다. (출처: 아래 profiles-and-sessions)
- 앱마다 주간 한도를 정할 수 있습니다: ChatGPT 설정 > 사용량(Usage) > 앱 한도(App limits) > 이 앱의 Manage limits. 바로가기: https://chatgpt.com/settings/usage
- 한도에 도달하면 AI 창에 "사용 한도에 도달했습니다"와 "사용량 관리" 버튼이 나옵니다. 한도가 요금제 전체인지 이 앱에 정한 것인지는 이 프로그램이 알 수 없습니다.
- 요금제가 모자라도 자동으로 다른 결제 수단으로 바뀌지 않습니다.

## 연결 해제 (철회)

- 이 컴퓨터에서: `node dah-connect.mjs logout` (ChatGPT 쪽 갱신 토큰도 철회하고 이 컴퓨터의 로그인 정보를 지웁니다). `--forget`을 붙이면 등록 정보와 짝짓기 정보까지 지웁니다.
- ChatGPT에서: 설정 > 보안 및 로그인(Security and login) > 로그인 연결(Login connections) > Sign in with ChatGPT > DAH Connect > Manage connection > Disconnect. 철회를 확인하지 못했다는 안내가 나왔거나 컴퓨터를 잃어버렸다면 여기서 끊으세요. 끊어도 이미 기록된 사용량은 되돌려지지 않습니다.
- 워크스페이스에서: AI 설정 > 이 브라우저 연결 끊기.

## 프라이버시와 보안

| 항목 | 내용 |
| --- | --- |
| 토큰 저장 | macOS에서 키체인을 쓸 수 있으면 키체인에 둔 무작위 키로 암호화한 파일. 아니면 소유자만 읽는 파일(권한 0600). 위치: macOS `~/Library/Application Support/DAH Connect`, Linux `~/.config/dah-connect`, Windows `%APPDATA%\DAH Connect` |
| 토큰이 가는 곳 | OpenAI(`auth.openai.com`, `api.openai.com`)뿐. 워크스페이스 서버, 브라우저(localStorage 포함), 로그에는 가지 않습니다 |
| 브라우저에 저장되는 것 | 짝짓기 비밀값(무작위 43자). 이 값만으로는 ChatGPT에 접근할 수 없고, 이 컴퓨터의 연결 프로그램에만 쓰입니다. 프로그램에는 이 값의 해시만 저장됩니다 |
| 서버 주소 | `127.0.0.1`에만 묶음(`0.0.0.0` 아님). 같은 와이파이의 다른 기기는 접속할 수 없습니다 |
| 허용 사이트 | `https://dah-workspace.vercel.app`뿐. 그 밖의 사이트는 403. 개발용으로 `--dev` 또는 `--origin`을 줄 때만 추가됩니다 |
| 요청 검증 | 모든 요청에 `Authorization: Bearer 비밀값` 필요, Host 헤더 검사(DNS 리바인딩 방어), JSON만 허용, 본문 크기 한도(채팅 3MB, 짝짓기 2KB), 동시 채팅 4개 제한 |
| 연결 코드 | 6자리, 15분, 한 번만. 5번 틀리면 코드 폐기 + 5분 잠금 |
| 기록 | 프롬프트, 답변, 토큰, 비밀값은 기록하지 않음 |

## 알려진 제한 (OpenAI의 "preview limitations")

- 최대 출력 토큰, 온도(temperature) 설정은 이 방식에서 거절되는 필드라 보내지 않습니다. AI 창의 해당 설정은 무시됩니다.
- 이미지 생성, 파일 검색, Code Interpreter, 컴퓨터 사용, 외부 MCP/커넥터, `tool_search`는 쓸 수 없습니다. 워크스페이스의 문서 편집 도구(함수 도구)는 쓸 수 있습니다.
- 이미지 입력은 고른 모델이 받을 때만 됩니다. 음성·영상은 안 됩니다.
- 쓸 수 있는 모델은 계정마다 다릅니다. 모델 목록은 로그인한 계정에서 받아 옵니다.
- 이 기능은 OpenAI 쪽에서 "preview"입니다. 규칙이 바뀌면 동작이 달라질 수 있습니다.

## 명령

```
node dah-connect.mjs start     로그인(필요하면) 후 서버 켜기 (권장)
node dah-connect.mjs login     ChatGPT 로그인 (--reconsent: 요금제 허용 화면 다시)
node dah-connect.mjs serve     서버만 켜기 (--dev, --origin <주소>)
node dah-connect.mjs status    로그인·저장 상태 보기
node dah-connect.mjs logout    로그인 정보 지우기 (--forget)
```

환경 변수: `DAH_CONNECT_ORIGINS`(허용 사이트, 쉼표로 구분), `DAH_CONNECT_DEV=1`(localhost 개발 서버 허용), `DAH_CONNECT_HOME`(저장 폴더 바꾸기), `DAH_CONNECT_STORE=file`(키체인을 쓰지 않음).

## 개발자용

- 의존성 없음, Node 20 이상. 시험: `node --test test/*.test.mjs` (가짜 OpenAI 서버를 로컬로 띄워 로그인·갱신·스트리밍·보안을 시험합니다. 실제 OpenAI를 부르지 않습니다)
- 구성: `lib/oauth.mjs`(로그인·갱신·로그아웃), `lib/jwt.mjs`(ID 토큰 검증), `lib/store.mjs`(저장), `lib/responses.mjs`(Responses 어댑터), `lib/server.mjs`(로컬 서버), `lib/pairing.mjs`(짝짓기)
- 개발·시험용 주소 바꾸기(`DAH_CONNECT_DEV_ISSUER`, `DAH_CONNECT_DEV_API_BASE`)는 `http://127.0.0.1` 주소만 받습니다.
- 서버 API
  - `GET /status` 비밀값 없이: 실행 중인지, 짝짓기 필요한지만. 비밀값과 함께: 로그인 상태, 제한, 가린 이메일
  - `POST /pair` `{code}` -> `{secret, installId}`
  - `POST /unpair`
  - `GET /models` -> `{models:[{id,name}], suggested}`
  - `POST /chat` 워크스페이스 AI 창 계약(`client/src/components/ai/README.md`)의 SSE. 이벤트 `text` / `tool_call` / `done` / `error`. 스트림이 열리기 전 실패는 JSON `{error, code}` (`UNAUTHORIZED`, `NOT_LOGGED_IN`, `RECONNECT`, `PLAN_DISABLED`, `PLAN_LIMIT`, `NOT_ELIGIBLE`, `UNSUPPORTED`, `UPSTREAM`, `BAD_REQUEST`, `TOO_LARGE`, `BUSY`)
- 따로 공개하기: `./export.sh <폴더> [저장소 주소]` (오픈소스 경로는 공개 MIT 저장소일 때 적용됩니다)
- 문서와 모호했던 부분: `DOCS-NOTES.md`, 실제 로그인 시험 순서: `TEST-REAL-LOGIN.md`

## 따른 문서

- https://developers.openai.com/siwc
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/ui-ux-guidelines
- https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites

## 라이선스

MIT (LICENSE). 이 프로그램은 OpenAI와 무관한 독립 프로젝트입니다.
