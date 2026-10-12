# 문서와 모호했던 부분, 선택한 방법

기준 문서: OpenAI "Sign in with ChatGPT" 의 ChatGPT plan usage (오픈소스 앱) 페이지들(README 의 "따른 문서"). 아래는 문서가 분명히 말하지 않아 이 프로그램이 정한 것들이다. 실제 서비스에서 확인되지 않았다.

| 주제 | 문서 | 선택 |
| --- | --- | --- |
| 콜백 포트 | sign-in: "초기 등록부터 127.0.0.1 루프백, 예시 `http://127.0.0.1:1455/auth/callback`. 이후 로그인은 다른 빈 포트 가능, 포트만 바뀔 수 있음" | 1455 를 먼저 쓰고 사용 중이면 빈 포트. 첫 등록을 다른 포트로 해도 되는지는 문서에 없다 |
| 호스트 id | JWK 지문 URI 권장, UUID 도 허용 | `urn:uuid:` + UUIDv4 를 첫 로그인 전에 만들어 host.json 에 저장 (비밀키를 보관하지 않으려고) |
| `earliest_refresh_at` | 토큰 응답 필드로만 나열, 형식·의미 설명 없음 | 초/밀리초/ISO 모두 읽고, 아직 만료 전이면 이 시각 전에는 갱신하지 않음. 만료됐으면 이 시각과 상관없이 갱신 시도 |
| 갱신 시점 | "만료 근처에서 표준 갱신" | 만료 5분 전부터 |
| 토큰 응답의 `scope` | "토큰 응답의 허용 범위로 판단" | 없으면 콜백의 scope, 그것도 없으면 액세스 토큰 본문의 scope(서명 검증 없이 읽기만) |
| 도구 형식 | preview-limitations: "함수/커스텀 도구는 네임스페이스로 묶거나 `additional_tools` 입력 항목으로" (형식 예시 없음) | 먼저 일반 function 도구. 이 경로가 `subscription_sharing_unsupported_capability`(param 에 tool)로 거절하면 `{type:"namespace", name, description, tools:[...]}` 로 묶어 한 번 더 시도. `additional_tools` 는 쓰지 않음. 네임스페이스 형식은 추정이라 실서비스에서 확인 필요 |
| `include: reasoning.encrypted_content` | 금지 필드 목록에 없음 | 보냄. 거절(400)되면 빼고 한 번 더 |
| 지원 필드 | `max_output_tokens`, `temperature` 등은 금지 | 보내지 않음. 화면의 최대 출력 토큰 설정은 무시되고 안내문에 적음 |
| 한도 오류 | 429 `subscription_sharing_usage_limit_exceeded`, "플랜 전체가 소진됐다고 가정하지 말 것" | `PLAN_LIMIT` + 사용량 링크, 재설정 시각은 추정하지 않음 |
| 스트림 시작 전 `{detail}` 오류 | "안정적인 코드가 아니라 진단 문장" | 상태 코드로만 분류하고 문장은 가려서 짧게만 보임 |
| 401 | 허용 신호/권한이 받아들여지지 않음 | 한 번 강제 갱신해 다시 시도, 그래도 401 이면 `RECONNECT`. 갱신 자체가 확정적 오류면 토큰을 지우고 등록(client_id)은 남김 |
| 요금제 권한 없음 | 로그인은 유지하고 비활성 표시, 사용자가 명시적으로 허용을 고르면 같은 client_id 로 `prompt=consent` | `login` 을 다시 실행하면(권한이 꺼져 있을 때 자동, 또는 `--reconsent`) `prompt=consent`. `force_reconsent` 는 OpenAI 가 배포를 확인한 뒤에만 쓰라고 해서 쓰지 않음 |
| 환영 안내 | 첫 로그인에서만 "ChatGPT 요금제를 사용 중입니다 / Got it" | 터미널에서 한 번 보이고 Enter 로 확인(registration.json 의 `welcomed_plan`). 웹 AI 창에는 상시 "ChatGPT 요금제 사용 중 · 사용량 관리" 표시 |
| 다중 계정 | 계정 선택/여러 등록 관리 권장 | 범위를 좁혀 한 계정만. 다른 계정으로 로그인하면 기존 자격 증명을 바꾸지 않고 거절 |
| 로그아웃 | 철회 엔드포인트에 POST, 5xx 는 백오프로 재시도 | 세 번까지 재시도 후 실패하면 로컬은 지우고 "철회를 확인하지 못함" 안내 |
| 갱신 경쟁 | "같은 세션의 갱신을 직렬화" | 프로그램 안에서는 하나의 약속(promise), 프로그램 사이에서는 잠금 파일 + 잠금 뒤 다시 읽기 |
| WebSocket | 선택 사항 | 쓰지 않음(HTTP/SSE 만) |
| 모델 목록 | `GET /v1/models` -> `models[]` (`slug`, `display_name`, `visibility`) | `visibility == "list"` 만, 서버 순서 유지, 첫 항목을 추천 |
| 서명 알고리즘 | "JWKS 로 검증" 만 | RS256/384/512, PS256, ES256/384 만 허용. `none`, HS* 거절 |
| ID 토큰 `aud` | 발급된 client_id | 문자열 또는 배열 모두 허용 |
| 상업 앱 | 호스팅/상업 앱은 신청서 필요 | 이 프로그램은 사용자 컴퓨터에서 도는 오픈소스로만 배포해야 함(공개 MIT 저장소) |

브라우저 쪽(문서 밖, Chrome): Private Network Access 사전 요청 응답(`Access-Control-Allow-Private-Network`)과, Chrome 142 이후 Local Network Access 허용 창을 안내한다. https://developer.chrome.com/blog/local-network-access
