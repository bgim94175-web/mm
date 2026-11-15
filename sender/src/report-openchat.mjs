// 오픈채팅 "신고하고 나가기" HTTP 경로. APK 26.8.3 dex 분석 결과:
//   호스트       = https://open.kakao.com (확정 — talk/katalk 는 404)
//   경로         = /c/fraud/report/chatLogs
//   메서드       = POST
//   바디 모양   = ChatLogsReportParams(Lcom/kakao/talk/abusereport/base/model/)
//     { category:String, linkId:long, chatId:long, chatLogInfos:String }
//   category    = rg61 enum 의 name() (SPAM · SEXUAL · FRAUD · ILLEGAL · VIOLENT · ...)
//   chatLogInfos = JSON-encoded 문자열. **배열이 아닌 문자열**.
//                  배열 안 각 원소 = { u, m:{message,referer,revision}, s, t, l, scope, threadId? }
//                  (Lyud1;->f + Lyud1;->j 가 조립)
import { get as getCred } from './report-auth.mjs'
import { randomUUID } from 'node:crypto'

export const HOST = 'https://open.kakao.com'
export const PATH = '/c/fraud/report/chatLogs'

// APK Lrg61 enum. sr 0~11 과 그 enum 이름 매핑.
export const CATEGORIES = [
  'SEXUAL', 'RIGHT', 'ILLEGAL_FILMING', 'FRAUD', 'SPAM', 'SUICIDE',
  'PROTECTCHILD', 'VIOLENT', 'ILLEGAL', 'PRIVACY', 'YOUTH_UNSUITABLE', 'ETC',
]

const GAP = 400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// APK 26.8.3 dex 분석 확정:
//   dbg (CustomHeaderInterceptorFactory) + bi90 (KT 공통) + s0 (ADID) + vde0 (OpenLink)
// 이 체인에서 openchat 요청에 실제로 붙는 헤더:
//   - Authorization: oauthToken 만 (c4c0.i() — **`-duuid` 접미사 없음**).
//     프로필 신고(/talk/profile25/report) 경로만 duuid 를 붙임 — 이 경로는 아님.
//   - A: android/26.8.3/ko
//   - C: 요청마다 랜덤 UUID v4 (correlation id — 서버 로그 추적용)
//   - Accept-Language: ko
//   - User-Agent: KT/26.8.3 An/13 ko  (Build.VERSION.RELEASE → Android 13)
//   - ADID: Google Advertising ID — 봇은 안 보내는 게 추적 회피에 유리하므로 생략
function authHeader() {
  const c = getCred()
  if (!c || !c.oauthToken) throw new Error('로그인 안 됨')
  return {
    'Authorization': c.oauthToken,
    'A': 'android/26.8.3/ko',
    'C': randomUUID(),
    'Accept-Language': 'ko',
    'User-Agent': 'KT/26.8.3 An/13 ko',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
}

// chatLogInfos 는 **문자열** (JSON 배열). 큰 ID(u/l) 가 2^53 넘으면 Number() 로 뭉개져서
// 서버 -203 → 수동 조립으로 raw JSON number 유지.
function jsonEscape(s) {
  return String(s).replace(/[\\"\n\r\t\u0000-\u001f]/g, (c) => {
    if (c === '\\') return '\\\\'
    if (c === '"') return '\\"'
    if (c === '\n') return '\\n'
    if (c === '\r') return '\\r'
    if (c === '\t') return '\\t'
    return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4)
  })
}
function longStr(v) {
  // 입력: string|number|bigint — 전부 digit-only string 으로
  if (v == null || v === '') return '0'
  if (typeof v === 'bigint') return v.toString()
  const s = String(v).trim()
  if (/^-?\d+$/.test(s)) return s
  // 이상한 값이면 0
  return '0'
}

// 한 개 메시지 → JSON object 문자열. 필드 순서는 APK Lyud1;->j(StringBuilder 조립 순서) 와 바이트 단위로 일치:
//   u → m{message→referer→revision} → s → t → l → scope → [threadId]
// isPrimary=true 일 때만 authorIdOverride·injectText 가 적용됨 (extra 들은 각자 실제 값 그대로).
function logItem(lg, isPrimary) {
  const uRaw = (isPrimary && lg.authorIdOverride != null && lg.authorIdOverride !== '')
    ? lg.authorIdOverride
    : lg.authorId
  const u = longStr(uRaw)
  const l = longStr(lg.logId)
  const s = Number(lg.sendAt) || 0
  // type==0 (시스템 메시지) 도 유효한 값이라 || 1 은 바이트 왜곡. 숫자로 파싱되면 그대로 유지.
  const tn = Number(lg.type)
  const t = Number.isFinite(tn) ? tn : 1
  const rawMsg = (isPrimary && lg.injectText && String(lg.injectText).trim())
    ? String(lg.injectText)
    : String(lg.message || '')
  const msg = jsonEscape(rawMsg)
  const parts = [
    '"u":' + u,
    '"m":{"message":"' + msg + '","referer":0,"revision":0}',
    '"s":' + s,
    '"t":' + t,
    '"l":' + l,
    '"scope":1',
  ]
  // APK yud1.f() 는 `put("threadId", chatLog.p1())` 를 무조건 호출하고 null 일 때만 remove.
  // primitive long 이면 0 이어도 `"threadId":0` 송출. 우리는 메시지 데이터에 threadId 가
  // 명시된 경우에만 포함 (정의 안 되면 생략) — null-remove 와 바이트상 동일.
  if (lg.threadId != null && lg.threadId !== '') {
    parts.push('"threadId":' + longStr(lg.threadId))
  }
  return '{' + parts.join(',') + '}'
}

export function buildChatLogInfosString(ctx) {
  // 기본: primary 메시지 하나.
  const items = [logItem(ctx, true)]
  // 같은 저자의 추가 메시지 — UI 에서 "같은 저자 메시지 함께 신고" 체크 시 extraLogs 에 담겨 들어옴.
  // 서버가 chatLogInfos 를 배열로 받는 이유 자체가 다건 묶음 신고를 지원하기 위함 (앱 UI 의
  // "메시지 여러 개 체크해서 신고" 와 동일 경로). primary 의 injectText 는 extra 에는 적용 안 함
  // — extra 는 "같은 저자가 과거에 실제로 보낸 다른 글들" 이라는 맥락이어야 심사자료로 합리적.
  if (Array.isArray(ctx.extraLogs)) {
    for (const extra of ctx.extraLogs) {
      if (!extra || !extra.logId || !extra.authorId) continue
      items.push(logItem(extra, false))
    }
  }
  return '[' + items.join(',') + ']'
}

export function buildBody(ctx, category) {
  // ChatLogsReportParams kotlinx-serialization 필드 선언 순서:
  //   category → linkId → chatId → chatLogInfos
  // kotlinx 는 선언 순서대로 바이트를 뱉으므로 같은 순서로 수동 조립 → 바이트 일치.
  // linkId/chatId 는 Long. JSON.stringify 의 Number 통로는 2^53 초과시 정밀도 손실.
  const linkId = longStr(ctx.linkId)
  const chatId = longStr(ctx.chatId)
  const cat = jsonEscape(String(category || 'SPAM'))
  const infos = jsonEscape(buildChatLogInfosString(ctx))  // 바깥 JSON 안에 문자열로 들어감 → escape 한 번 더
  return {
    _raw: '{"category":"' + cat + '","linkId":' + linkId + ',"chatId":' + chatId + ',"chatLogInfos":"' + infos + '"}',
  }
}

// extra 메시지 묶음은 바디가 커져 4초는 빡빡함. 신고가 느려도 abort 로 날아가지 않게 8초.
async function hit(body, { timeoutMs = 8000, host = HOST } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  // body 가 { _raw: "..." } 이면 raw JSON 문자열을 그대로, 아니면 stringify
  const payload = body && typeof body._raw === 'string' ? body._raw : JSON.stringify(body)
  try {
    const r = await fetch(host + PATH, {
      method: 'POST',
      headers: authHeader(),
      body: payload,
      signal: ctrl.signal,
    })
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch (e) {}
    // 응답 헤더 전부 수집 — Location / X-Report-Id / Set-Cookie 등 바디엔 없는 추적 ID 를 찾는 목적
    const headers = {}
    try { for (const [k, v] of r.headers) headers[k] = v } catch (e) {}
    return {
      httpCode: r.status,
      status: j && typeof j.status === 'number' ? j.status : null,
      body: j,
      text: !j ? text.slice(0, 200) : null,
      sent: payload.slice(0, 400),  // 디버그: 실제 보낸 body 앞 400자
      headers,
    }
  } catch (e) {
    return { httpCode: 0, err: String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(t)
  }
}

// 한 카테고리로 한 번 쏘기
export async function reportOne(ctx, category) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  // linkId 누락 시 longStr('') → '0' 으로 송출됨. 오픈채팅 신고는 반드시 linkId 필요 — raw 호출
  // (UI 가 pickRoom 안 거침) 에서 빠질 수 있음.
  if (!ctx.linkId) return { ok: false, text: 'linkId 필요 (방을 pickRoom 으로 선택해야 자동 채워짐)' }
  const body = buildBody(ctx, category)
  const r = await hit(body)
  const ok = r.httpCode === 200 && r.status === 0
  return {
    ok, category, sent: r.sent, http: r.httpCode, status: r.status, respBody: r.body, respHeaders: r.headers, text: r.text,
    msg: (ok ? '★ 접수' : '실패') + ' category=' + category + ' http=' + r.httpCode + ' status=' + r.status + (r.err ? ' err=' + r.err : ''),
  }
}

// 12개 카테고리 전부 — 3개씩 병렬로 4묶음 (전체 ~5초). Safari fetch 타임아웃 안 걸림.
export async function fireAll(ctx) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  const results = []
  const BATCH = 3
  for (let i = 0; i < CATEGORIES.length; i += BATCH) {
    const chunk = CATEGORIES.slice(i, i + BATCH)
    const rs = await Promise.all(chunk.map((cat) => reportOne(ctx, cat)))
    rs.forEach((r) => { results.push(r); console.log('openchat fireAll ' + JSON.stringify(r)) })
    if (i + BATCH < CATEGORIES.length) await sleep(GAP)
  }
  const rows = results.map((r) => r.category + ' → http=' + r.http + (r.status != null ? '/s=' + r.status : '') + (r.text ? ' "' + String(r.text).slice(0, 80) + '"' : ''))
  const acceptedCats = results.filter((r) => r.ok).map((r) => r.category)
  return { ok: acceptedCats.length > 0, accepted: acceptedCats.length, acceptedCats, rows, text: '접수 ' + acceptedCats.length + '/' + CATEGORIES.length + ' [' + acceptedCats.join(',') + ']\n' + rows.join('\n') }
}

// --- 호환성: 예전 UI 가 부르던 엔드포인트 유지 ---
export async function probeHosts(ctx) {
  const r = await reportOne(ctx, 'SPAM')
  return {
    ok: r.ok, host: HOST, rows: [HOST + ' → http=' + r.http + '/s=' + r.status],
    text: '(단일 호스트 확정) ' + HOST + '\n' + r.msg,
  }
}
export async function probeShapes(host, ctx) {
  // 바디 모양은 APK 로 확정됨. 그냥 SPAM 로 한 번 쏴 보고 상태 보고.
  const r = await reportOne(ctx, 'SPAM')
  return { ok: r.ok, rows: [r.msg], text: r.msg + '\n(바디 모양은 APK 기준 확정 — 이 결과는 "경로 작동 여부" 확인)' }
}
export async function fire(host, ctx, reasons) {
  // reasons 는 sr 번호. CATEGORIES 로 매핑 (0=SEXUAL, 4=SPAM 등).
  const cats = Array.isArray(reasons) && reasons.length
    ? reasons.map((i) => CATEGORIES[Number(i)] || 'SPAM')
    : CATEGORIES
  const rows = []
  let accepted = 0
  const acceptedCats = []
  for (const cat of cats) {
    const r = await reportOne(ctx, cat)
    rows.push(cat + ' → http=' + r.http + (r.status != null ? '/s=' + r.status : ''))
    if (r.ok) { accepted += 1; acceptedCats.push(cat) }
    await sleep(GAP)
  }
  return { ok: accepted > 0, count: accepted, rows, text: '실제 접수 ' + accepted + '/' + cats.length + ' [' + acceptedCats.join(',') + ']\n' + rows.join('\n') }
}
