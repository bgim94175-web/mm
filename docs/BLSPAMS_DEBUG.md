# BLSPAMS 신고 메서드 디버깅 — 현재 상태 · 다음 단계

작성 2026-11-14. 세션 넘어가도 이 문서만 읽으면 어디까지 왔는지 복원된다.

---

## 1. 지금까지 확정된 사실

| 사실 | 근거 |
|---|---|
| LOCO 메서드 이름 = `BLSPAMS` | APK 26.8.3 디컴파일 (`sender/src/report-msg.mjs` 참고) |
| 바디 모양 = `{st:int, c:Long, ls:[Long], ss:[Long], lds:[String], lts:[Integer], sr:int, bi:Boolean?}` | 같은 APK |
| `bi` 는 nullable, `st==3` 일 때만 보냄 | APK |
| `li`·`at`·기타 필드는 BLSPAMS 바디에 없음 | APK |
| 서버 반환: LOCO statusCode=0, body.status=**-301** | 라이브 콘솔 시험 (여러 방·여러 사람·여러 변형 전부) |
| `-301` = `INTERNAL_SERVER_ERROR_BO` | 비공식 공개 LOCO 상수표 |
| 해외 계정도 앱에서 신고 정상 작동 | 사용자 확인 |
| 안드로이드 서브디바이스(태블릿)도 "신고하고 나가기" 메뉴 있음 | 사용자 확인 |
| 앱에서 "신고하고 나가기" 하면 **실제로 방에서도 나가짐** | 사용자 확인 |

## 2. 시험한 변형 (전부 `body.status=-301`)

- 메서드 후보 7개: `BLSPAMS`·`LBLSPAMS`·`OREPORT`·`OCREPORT`·`REPORT`·`CHATREPORT`·`SPAMMSG` → BLSPAMS 만 `b!=-300` (= BLSPAMS 가 유일한 메서드)
- 바디 변형 (전부 `-301`):
  - `baseline` (기본), `+li`, `+orig(lds)`, `+at`, `+li+orig`, `+li+at`, `+li+at+orig`
  - `bi=true`, `bi=null`, `no-bi`
  - `st=0`, `st=1`, `st=2`, `st=4`
  - `sr=1`(홍보)
  - `minimal{c,ls,sr}`
  - `warmup+orig`, `warmup+orig+bi=true`, `warmup+baseline` (CHATONROOM 먼저 → BLSPAMS)

## 3. 남은 가설 (해보지 않음)

**순서는 "확률 × 비용" 기준.**

### ~~가설 3 — Rate limit 대기~~ ❌ 기각 (2026-11-14)
- 15분 대기 후 1.5초 간격으로 sr 0~5 발사 → 전부 `body.status=-301`
- rate limit 이었으면 한두 개는 뚫렸어야 함 → 서버가 구조적으로 거부

### ★★★ 2026-11-14 완전 해석 ★★★

**APK 26.8.3 dex 분석 (androguard, 내가 직접) 결과:**

- **호스트**: `https://open.kakao.com` (라이브 응답 200 확인)
- **경로**: `POST /c/fraud/report/chatLogs`
- **바디 (ChatLogsReportParams, 서브클래스 `Lcom/kakao/talk/abusereport/base/model/ChatLogsReportParams$a` 의 kotlinx-serialization 레지스터로 확정):**
  ```json
  {
    "category": "<enum name>",      // String
    "linkId": <long>,
    "chatId": <long>,
    "chatLogInfos": "<string>"      // ★ JSON-인코드 문자열, 배열 아님!
  }
  ```
- **category 값** (`Lrg61;` enum 12개):
  `SEXUAL · RIGHT · ILLEGAL_FILMING · FRAUD · SPAM · SUICIDE · PROTECTCHILD · VIOLENT · ILLEGAL · PRIVACY · YOUTH_UNSUITABLE · ETC`
- **chatLogInfos 포맷** (`Lyud1;->f` + `->j` 가 조립):
  ```
  JSON.stringify([{
    u: <authorId long>,
    m: { message: <text>, referer: 0, revision: 0 },
    s: <sendAt int>,
    t: <type int>,
    l: <logId long>,
    scope: 1,
    threadId: <long|null>   // 선택
  }])
  ```

**이전 "모든 바디 거부 b=-500" 원인:** `chatLogs: [...]` (배열) 로 보냈음. 서버는 `chatLogInfos: "[...]"` (문자열) 를 기다림.

### ~~오픈채팅 신고는 BLSPAMS 가 아님~~ (이제 진짜 바디 확정됨)

APK 26.8.3 재확인 결과 (사용자가 넘김):
- BLSPAMS 는 일반(1:1·단체) 채팅방 전용: `AbuseReportChatroomUseCase → ReportSpamAtChatRoomUseCase → LocoImpl.blSpams`
- 오픈채팅은 별도: `OlkChatroomAbuseReportApiParams → AbuseReportViewModel.submitOlkChatroomReport → AbuseReportOlkChatroomUseCase → POST c/fraud/report/chatLogs`

**→ 봇이 BLSPAMS 로 오픈챗 메시지 신고를 시도한 게 -301 의 근본 원인.** 서버가 "오픈챗은 이 경로 아니다" 로 BO 레이어에서 거부한 것.

**지금 구현한 것 (`sender/src/report-openchat.mjs`, feat/report-console 브랜치):**
- `/report/openchat-hosts` (POST) — 호스트 후보 4개 돌려서 어느 쪽이 받는지 (talk · katalk · open · dn-m)
- `/report/openchat-shapes` (POST) — 호스트 확정된 뒤 바디 모양 5개 (shape-A~E) 변형 탐색
- `/report/openchat-fire` (POST) — 호스트 + 바디 모양 확정 뒤 sr 0~5 발사
- UI "오픈채팅 HTTP 신고" 섹션

**미확정:**
- 정확한 호스트 (후보 4개 중 하나)
- 바디 모양 — `OlkChatroomAbuseReportApiParams` 의 실제 JSON 필드 이름
- 인증 헤더 포맷 — 일단 기존 `/talk/profile25/report` 와 같은 `${oauthToken}-${duuid}` 사용

### ~~가설 2 — APK 생성자 재확인~~ ✅ 완료 (위 참조)
구글 드라이브 `카카오톡_26.8.3 (1).apk` (254MB) 또는 이미 깐 jadx 세션에서:
- `grep -r "BLSPAMS"` 후 호출 지점 전체 (한 군데가 아닐 수 있음)
- `BlockSpamsRequest`·`ChatReportRequest`·`SpamReport*` 류 클래스의 **생성자·정적 팩토리 메서드** 전체 — 조건부로 추가 필드 넣는 경우 확인
- 특히 봐야 할 것:
  - `sr` 값에 따라 필드 더 붙는지 (ex. `sr==0` 일 때 `attach` 필드)
  - 채팅 타입(오픈챗 vs 일반)에 따라 분기
  - 세션 state(멤버 권한·방 상태) 체크 후 분기
  - `bi` 가 nullable 인데 **실제로는 꼭 true 보내는 경로만** 있는지 (= 신고=나가기 이므로 bi 는 항상 true?)

### 가설 1 — PC frida 로 실제 바이트 캡처
가설 3·2 다 틀렸을 때. **결정적**.
- 스크립트: `tools/frida/pc-loco-capture.js` (작성 완료)
- 쓰는 법:
  1. Windows PC 에 카카오톡 PC 버전 설치, 그 계정으로 로그인
  2. [frida 설치](https://frida.re) (`pip install frida-tools`)
  3. 카카오톡 PC 켜놓은 상태에서 명령:
     ```
     frida -l tools/frida/pc-loco-capture.js "KakaoTalk.exe" --no-pause
     ```
  4. 카카오톡 PC 에서 아무 오픈챗 방 들어가 "신고하고 나가기" 한 번만 실행
  5. frida 콘솔에 뜨는 `LOCO_* method=BLSPAMS body_bson=<hex>` 저장
  6. 같은 메시지로 **우리 콘솔** (`mm-iwo1.onrender.com`) 에서 "BSON hex 덤프" 버튼 → hex 저장
  7. 두 hex 를 바이트 단위로 diff — 다른 바이트가 어느 필드인지 보면 정답

**스크립트가 훅하는 지점 3군데:**
- `ws2_32.send` — 소켓 쓰기 직전 raw (LOCO AES-GCM 후)
- `secur32.EncryptMessage` — SChannel TLS 평문 (booking/checkin 서버와의 TLS)
- `bcrypt.BCryptEncrypt` — LOCO AES-GCM 자체 암호 **전** 평문 (여기가 핵심)

평소에는 bcrypt 훅에서 BSON 이 평문으로 뜸. 안 뜨면 send 훅의 raw 를 보고 LOCO 자체 암호 레이어를 수동 복호해야 함.

## 4. 코드 상태 (현재 라이브: `feat/report-console` 브랜치, `mm-iwo1.onrender.com`)

- `sender/src/report-msg.mjs`
  - `probeShape()` : 7개 변형 BLSPAMS 자동 시험 (CHATONROOM warmup 포함)
  - `dumpBytes()` : 지금 보내려는 BSON 바디 hex 덤프
  - `fire()` : 확정된 메서드로 sr 0~5 발사 (body.status 기준 성공 판정)
- `sender/src/report-server.mjs`
  - `POST /report/msg-shape` : 변형 탐색
  - `POST /report/msg-dump` : hex 덤프
  - `POST /report/raw` : 임의 LOCO method+body
  - `POST /report/loco-reconnect`
  - `GET /report/rooms` · `GET /report/room-msgs` · `GET /report/member-link`
- `sender/src/report-browse.mjs` : 방 목록·메시지·오픈프로필 링크
- `sender/src/report-loco.mjs` : `client.ensureSession()` 로 LOCO 붙임, `loginResult()` 노출
- `sender/public/report/index.html` : 둘러보기 UI + 변형 탐색 + hex 덤프 버튼

SW 캐시 현재 버전: `rp-v16` (`sender/public/report/sw.js`).
배포 대상 브랜치: Render 가 `feat/report-console` 감시 (환경: `mm-iwo1.onrender.com`).

## 6. 지속성 (2026-11-14 추가)

- `sender/src/report-db.mjs` — Neon Postgres 자격증명 저장소
- `DATABASE_URL` 환경변수 있으면 Postgres, 없으면 로컬 파일(ephemeral)
- 서버 부팅 시 자동 `preload()` → 저장된 토큰 있으면 `LOCO.connect()` 자동 시도
- 테이블: `report_auth(id, oauth_token, refresh_token, user_id, duuid, email, device_type, updated_at)`
- `/me` 응답에 `dbBackend: "pg" | "file"` 추가, UI 에 🐘 Neon / 💾 file 표시
- Neon 세팅: console.neon.tech → New Project → connection string → Render env `DATABASE_URL` 로 붙여넣기

## 5. 세션 넘어온 사람에게 — 할 일 (우선순위)

1. 이 문서 다 읽기
2. 가설 3 결과 확인 (사용자가 "15분 대기 후 한 번만" 발사한 결과 공유)
3. 그 결과가 `-301` 이면 가설 2 (APK 재확인) — 사용자에게 추가 필드 찾아달라 요청
4. 그래도 `-301` 이면 가설 1 — 사용자가 PC frida 로 캡처
5. 캡처 hex 와 우리 hex 비교 → diff 나는 바이트가 어느 필드인지 (BSON 스펙: 0x10 int32, 0x12 int64, 0x02 string, 0x04 array, 0x08 bool)
6. 바디 맞추고 시험
