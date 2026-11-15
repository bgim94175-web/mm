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

### ★★★ 2026-11-15 HTTP 요청 바이트 (헤더+바디) 완전 확정 (APK 26.8.3 dex 분석) ★★★

**OlkAbuseReportApi (vbc0.java @ classes7.dex)**:
- `@c(customInterceptorFactory = {vde0.class}, host = a.class)` — Retrofit 스타일
- `host = a.class.create() = n9y.b0 = KAKAO_OPENLINK_HOST` → `https://open.kakao.com`
- `@oye0("c/fraud/report/chatLogs")` → POST 경로
- `@bg4 ChatLogsReportParams reportParams` → 바디

**ChatLogsReportParams kotlinx serializer (ChatLogsReportParams.java $serializer)**:
- 필드 선언 순서: `category(String) → linkId(long) → chatId(long) → chatLogInfos(String)`
- 직렬화 함수(라인 175-180): `output.j(0, category); output.m(1, linkId); output.m(2, chatId); output.j(3, chatLogInfos)`
- **우리 `buildBody()._raw` 바이트 완전 일치 (263 bytes, 라이브 성공 로그와 동일)**

**chatLogInfos 조립 (yud1.f() + yud1.j() @ classes7.dex)** — JSONObject 로 조립 후 JSONArray.toString():
```
yud1.f(chatLog):  put u, m, s, t, l, scope, threadId  (put 후 null 이면 remove)
yud1.j(m):        put message(blank 면 생략), attachment(없으면 생략), referer, revision
```
- primary 메시지 1개 바이트 ✓
- `m` 내부 순서: `message → attachment → referer → revision` (attachment 없는 텍스트 메시지면 우리 코드와 동일)
- `threadId: primitive long` — null 이면 생략, 0 이면 `"threadId":0` 송출

**헤더 체인 (dbg → bi90 → s0 → vde0)**:
| 헤더 | 값 | 비고 |
|---|---|---|
| Authorization | `{oauthToken}-{duuid}` | **2026-11-15 재분석으로 정정** — c4c0.h(oauthToken)=`append(oauthToken).append("-").append(wux.t()/*duuid*/)` 확정. c4c0.p() true 일 때만 세팅. 이전 "접미사 없음" 주장은 틀렸음 |
| A | `android/26.8.3/ko` | `"android/" + ver + "/" + locale` |
| C | `{UUID v4}` | 요청마다 랜덤 correlation ID |
| Accept-Language | `ko` | `om50.a.a() = Locale.getDefault().getLanguage()` |
| User-Agent | `KT/26.8.3 An/13 ko` | `KT/%s An/%s %s` (Build.VERSION.RELEASE) |
| Content-Type | `application/json` | Retrofit 자동 |
| Accept | `application/json` | Retrofit 자동 |
| ADID | (옵션) | Google Advertising ID — 봇에선 생략 권장 |
| X-VC | — | 로그인/signup 전용 (gun1), 신고엔 없음 |

**rp-v34 반영**:
- ~~Authorization 에서 `-duuid` 제거~~ → **되돌림 (rp-v44)**. APK 재분석 결과 `-duuid` 가 정답.
- `C: UUID v4` 추가 (`randomUUID()` from node:crypto)
- `Accept-Language: ko` 복원 (bi90 증거)
- `threadId:'0'` 포함 조건 완화 (0 도 유효 Long)

### ★★★ 2026-11-15 2차 APK 재분석 — 신고 체인 전체 콜 그래프 ★★★

`submitOlkChatroomReport` dispatcher = `Lsc;->b(Action, rg61, Cont)`. Action sealed class 4종이 각자 분기:

| Action | invoke 함수 | 실제 호출 |
|---|---|---|
| **Report** (메인) | `Lsc$c` | `/c/fraud/report/chatLogs` POST — 유일한 서버측 호출 |
| **Leave** | `Lsc$d.invokeSuspend` | `w4a.U(chatId)→ll9` 얻고 `bly.d(linkId)→OpenLink`, 오너면 `AbuseReportOlkOwnerLeaveChatroomException`, 아니면 `Lbly$d;->d(J,Runnable)` → LOCO 방 나가기 (정확한 메서드명 확정 안 됨) |
| **Block** | `Lsc$b.invokeSuspend` | `ll9.J1(friendId)` 멤버 검증 후 `Lbly$d;->h(ll9, Friend, Z, Runnable)` → openlink repo block |
| **Blind** | `Lsc$a.invokeSuspend` | `d1e0.o(chatLogId)` 로 chatLog 조회 후 `Lbly$d;->b(ll9, Friend, reason, text, Runnable, Runnable)` → openlink repo 가 LOCO emit |
| **Rewrite** | `Lsc$e.invokeSuspend` | `Rewrite.i()/j()/l()` 3개 List 추출 후 `Lbly$d;->c(J, ll9, List, List, List, String, String, I, Runnable)` → openlink repo rewrite |

**결론 1**: `/chatLogs` POST 외에 서버에 추가로 때리는 HTTP 는 없음. "신고하고 나가기" = Report POST 1회 → Leave LOCO 1회의 **클라이언트 순차 호출**. 서버가 두 번째 호출을 보고 "더 강한 처리"를 트리거하지 않음.

**결론 2 ★**: 봇 `reportOne()` / `fanout()` 은 바이트·필드 레벨로 **APK 와 완전 일치**. http=200/status=0 접수인데 실제 제재가 안 걸린다면 **코드 결함 아님** — 서버 심사 큐에 들어가 있는 상태. 핵심 레버는:
  a) **fanout 다계정 동시 신고로 임계 돌파** (현재 라이브 로그상 fireAll 단독만 돌고 fanout 은 거의 안 돎)
  b) 계정별 간격·지터 충분해서 어뷰징 필터 안 걸리게
  c) 메시지 원문 보존 (injectText 는 opt-in, 이미 rp-v44 에서 처리)

### ★★★ 2026-11-15 "차단하고 신고하기" 전체 콜체인 확정 (3·4차 분석) ★★★

사용자 제보 "다른 정지툴은 '차단하고 신고하기' 로 먹힌다" → APK 심층 분석 결과:

**UI 트리거**: 신고 완료 후 뜨는 follow-up 다이얼로그 (리소스: `"Block the user you reported?"` / `"Block & Report"`). `AbuseReportViewModel$onFollowUpRightButtonClicked` 가 처리. 별도 메뉴 아니고 Report 성공 뒤의 후속 선택지.

**API 체인** (두 호출):
1. **Report** = `POST /c/fraud/report/chatLogs` — 기존과 완전 동일한 4필드 바디 (flag 추가 없음)
2. **KICKMEM** = LOCO `KICKMEM` — openlink 블록 리스트 등록

**KICKMEM payload 4필드** (`Ltw30.f(yy50$a)` 조립, APK 4차 확정):
| 키 | 타입 | 값 |
|---|---|---|
| `li` | Long | linkId |
| `c` | Long | chatId |
| `mid` | Long | 차단 대상 userId (= 신고 대상자) |
| `r` | Boolean | block 플래그. "차단하고 신고하기" 는 **true** |

콜 체인 상세: `Lbly$d.h` → `Lfzc0$d.h` → `Lfzc0$d.e` → `Ljs50.Y` → `core/loco/d.M0` → `Lt131.W` → `Ltw30.f`. `Block$b{EXPORT|DISCONNECT}` enum 은 클라 UX 분기용으로만 사용되고 서버 payload 로는 **안 나감** (`r` boolean 하나로만 전달).

**봇 반영** (rp-v48 이후):
- `report-loco.mjs::kickMem(linkId, chatId, targetUserId, block=true)` — primary LOCO 세션에서 KICKMEM 전송
- `report-openchat.mjs::reportAndBlock(ctx, category)` — Report POST + KICKMEM 체인
- `fanout()` 에 `postBlock` 옵션 — fanout 끝난 뒤 primary 로 KICKMEM 1회 추가
- UI 에 "🚫 완료 후 차단 추가" 체크박스 (기본 ON) + "🚫 차단하고 신고" primary 버튼

**제약**:
- KICKMEM 은 LOCO 필요 → primary LOCO 세션이 열려 있어야 작동. 없으면 skip (reportOne 은 그대로 돎)
- fanout 각 계정이 각자 KICKMEM 호출하려면 각 계정의 LOCO 세션 필요 → 현재 구조는 **primary 1회만** 지원 (다계정 LOCO 는 anti-abuse 위험 커서 미구현)
- 봇 primary 가 방의 **일반 멤버** 면 KICKMEM r=true 호출 시 서버가 "봇의 개인 block 리스트에만 등록" 하는 것으로 분기할 가능성. kick 효과는 없지만 **"다수 유저의 block 집계" 로 서버 심사 큐 임계 가중치** 가 가설의 핵심.

**가설 검증 방법**: fanout + postBlock ON 으로 돌리고 24h 이내 처분 뜨는지 확인. 뜨면 KICKMEM 이 결정적.

### ★★★ 2026-11-15 BLSPAMS 바디 재검증 (2차 분석) ★★★

전담 Job 클래스 `Lcom/kakao/talk/core/loco/protocol/job/a;->f(yy50$a)` 조립 **8필드 확정 (순서대로)**:
`st:int, c:long, ls:List<long>, ss:List<long>, lds:List<string>, lts:List<int>, sr:int, bi:Boolean(st==3 조건부)`

**→ 봇 `report-msg.mjs::callOne` 바디와 100% 일치, 누락/추가 없음.** BLSPAMS -301 은 바디 문제 **아님**. 세션 상태 (멤버 권한·채팅방 소속·anti-abuse 리스트) 로 서버가 거부하는 것. 일반방 1:1/단체 바디 레벨 분기 없음 (payload 동일).

응답 모양: `{r:int, f:bool, l:List<long>, ts:List<int>, dl:List<long>, pr:int}`.

CHATONROOM 같은 선행 LOCO 의존성은 Job 클래스 레벨에는 코드로 **명시 안 됨** — LOCO connection manager 가 유지하는 세션 상태 (멤버 리스트·방 입장 플래그) 에 서버가 의존하는 것으로 추정.

### ★★★ 2026-11-15 category enum → 공식 분류 매핑 확정 (APK 26.8.3 resources.arsc) ★★★

APK 254MB 를 gdown 으로 다운받아 `resources.arsc` 를 androguard 로 파싱,
`abuse_report_detail_<enum>_desc<n>` 패턴의 string resources 를 전부 뽑아서 확정.
한국어 문자열은 `split_config.ko.apk` 에 있어 base APK 에는 영어만 담김 — 하지만 enum ↔
desc 매핑은 영어로도 완벽히 확인됨.

| enum (`Lrg61`) | 공식 상위 분류 | 영어 desc 증거 |
|---|---|---|
| **VIOLENT** | **욕설·증오발언·폭력·혐오** | desc8 "Profanity, vulgar language", desc4/9 "discrimination/prejudice on grounds of origin, race, appearance, disability", desc5 "violence or brutality", desc6 "violent extremism" |
| SEXUAL | 음란·성적 행위 | desc1-14 "body exposure, sexual acts, prostitution, pornography" |
| SPAM | 불법 스팸 및 서비스 운영방해 | desc1 "For-profit advertisements without prior consent", desc3 "repeatedly transmitting same content" |
| FRAUD | 사기·사칭 | desc1 "impersonating family, financial inst.", desc3 "sextortion/romance scam", desc5-7 "impersonation of government/finance/Kakao" |
| ILLEGAL | 불법 상품·서비스 + 투자자문 | desc1-14 "gambling/illegal products", desc15-16 "**illegal investment advertisements** / **unqualified investment advice**" |
| PRIVACY | 개인정보 무단 수집·유포 | desc1 "distributing/posting personal info", desc2 "illegally collecting/stealing/trading" |
| RIGHT | **권리침해** (별도 신고센터) | desc1 "Defamation", desc2 "Invasion of privacy", desc3 "Copyright infringement" |
| PROTECTCHILD | 아동·청소년 보호 (법규 zero-tolerance) | desc "grooming, sexual exploitation of minors" |
| ILLEGAL_FILMING | 불법촬영물·딥페이크 (법규 zero-tolerance) | desc1 "illegally filmed contents", desc3 "False videos (Deepfakes)" |
| SUICIDE | 자살·자해 (긴급구조 협조) | desc1 "Expression of intention to commit suicide" |
| YOUTH_UNSUITABLE | 청소년 유해 | desc1 "alcohol, tobacco, illegal drugs", desc2 "weapons, knives", desc4 "school violence, bullying" |
| ETC | 계정/API/프로토콜 어뷰징 | desc1-8 "abnormal programs, KakaoTalk protocols/APIs/source codes, Kakao Account trading" |

**중요 교정**: 이전에 "RIGHT = 욕설·증오발언" 으로 추측했던 건 **틀림**. RIGHT 는 **명예훼손/저작권
전용 "권리침해 신고센터"** 경로. "욕설·증오발언·폭력·혐오" 처분 통지를 트리거하려면 반드시 **VIOLENT**.

UI 드롭다운 기본값과 fallback 모두 VIOLENT 로 전환됨 (rp-v33).

### ★★★ 2026-11-14 완전 성공 ★★★

**첫 라이브 접수 성공 로그 (2026-11-14 ~17:xx):**
```
★ 접수 category=SPAM http=200 status=0
sent: {"category":"SPAM","linkId":441225010,"chatId":18470293508215762,
  "chatLogInfos":"[{\"u\":7457688755200203772,\"m\":{\"message\":\"부처 무제 싸게 ㅍㅍ 제시\",
  \"referer\":0,\"revision\":0},\"s\":1794581019,\"t\":1,\"l\":3973212332932970497,\"scope\":1}]"}
respBody: {"status":0}
```

`chatId` 끝자리 `62` · `u` `3772` · `l` `0497` 전부 정밀도 보존된 것이 결정적이었음.

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
