# PPT 발표 에이전트 (pt-agent)

PPTX를 업로드하면 슬라이드별로 LLM이 발표 스크립트를 쓰고, TTS로 읽어주는 AI 발표 도우미. 로그인(가입 승인제) + 사용자별 참고 문서 RAG + PPT 저장소를 서버가 직접 들고 있는 다중 사용자(멀티테넌트) 구조입니다.

## 구성

- `ppt-agent.html` — 클라이언트(단일 파일 SPA). 업로드/발표/설정 UI 전부 포함.
- `server.js` — Express 서버. 로그인/가입승인/관리자 페이지, RAG·PPT API, n8n 프록시.
- `db.js` — SQLite(`better-sqlite3`) 스키마 + 초기화.
- `lib/chunk.js` — 참고 문서 청킹(마크다운 헤딩 기준).

## 외부 의존성 (이 저장소엔 없음, 직접 준비해야 함)

이 서버는 LLM 스크립트 생성·로컬 LLM·TTS·임베딩을 **n8n 웹훅**을 통해 호출합니다. n8n 쪽에 다음 웹훅이 미리 구성되어 있어야 합니다(이 저장소는 n8n 워크플로 자체를 포함하지 않습니다):

| 웹훅 경로 | 용도 |
|---|---|
| `/webhook/koen-openai-script` | 슬라이드 발표 스크립트 생성 (OpenAI) |
| `/webhook/koen-local-llm` | 로컬 LLM 폴백 |
| `/webhook/koen-openai-embed` | 참고 문서 임베딩 |
| `/webhook/koen-openai-tts-bin` | OpenAI TTS (바이너리 오디오) |

각 웹훅은 요청 바디의 `key` 필드를 검사해 `N8N_KEY`(아래)와 일치할 때만 응답하도록 구성하는 걸 권장합니다 — 이 서버가 그 값을 자동으로 붙여서 호출합니다.

TTS(로컬 mlx 엔진)는 별도로 `TTS_URL`(코드 내 `ppt-agent.html`)이 가리키는 엔드포인트가 필요합니다.

## 설치/실행

```bash
npm install
cp .env.example .env   # 값을 채운 뒤, 실제로 서버에 전달하는 방법은 아래 참고
```

`.env` 파일은 참고용 문서일 뿐 자동으로 로드되지 않습니다 — 아래 중 하나로 실제 프로세스에 환경변수를 넘기세요:

```bash
# 간단 실행
N8N_KEY=실제키값 N8N_BASE=http://127.0.0.1:5680 NODE_ENV=production node server.js

# 또는 launchd/systemd 등 프로세스 관리자의 EnvironmentVariables/Environment= 설정 사용
```

최초 기동 시 `users` 테이블이 비어있으면 관리자 계정(`admin`)을 자동 생성합니다. 비밀번호는 `ADMIN_SEED_PASSWORD` 환경변수로 지정하거나, 비워두면 무작위로 생성해서 **시작 로그에 한 번만** 출력됩니다 — 로그에서 확인해서 로그인 후 즉시 바꾸세요.

## 배포 시 주의

- `server.js`는 특정 경로 프리픽스(`/ppt-agent`) 아래에서만 서빙된다고 가정하지 않습니다 — 포트를 그대로 리버스 프록시(nginx/frp 등) 뒤에 두면 됩니다. 쿠키는 `Path=/`로 스코프되어 있어 어떤 하위 경로든 안전하게 동작합니다.
- SQLite 파일(`data/app.db`)에는 사용자 비밀번호 해시·업로드된 문서·PPT가 전부 들어갑니다 — 절대 git에 커밋하지 마세요(`.gitignore`에 이미 포함).
- `NODE_ENV=production`이 아니면 세션 쿠키의 `Secure` 플래그가 꺼집니다(로컬 HTTP 테스트용). 운영에서는 반드시 `NODE_ENV=production`으로 실행하세요.
