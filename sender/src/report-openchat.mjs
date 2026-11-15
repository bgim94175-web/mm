// 오픈채팅 "신고하고 나가기" HTTP 경로. APK 26.8.3 dex 분석 결과:
//   호스트       = https://open.kakao.com
//   경로         = /c/fraud/report/chatLogs
//   메서드       = POST
//   바디 모양   = ChatLogsReportParams
//     { category:String, linkId:long, chatId:long, chatLogInfos:String }
import { randomUUID } from 'node:crypto'
import { get as getCred } from './report-auth.mjs'
import * as DB from './report-db.mjs'
import * as LOCO from './report-loco.mjs'
import * as POOL from './report-loco-pool.mjs'

export const HOST = 'https://open.kakao.com'
export const PATH = '/c/fraud/report/chatLogs'
// ★ 프로필(=오픈링크 자체) 신고 — "차단하고 신고하기" 상대 프로필 플로우 (APK 5차 확정).
// vbc0.g · OpenLinkReportParams { category:String, linkId:Long, attachmentPaths:List<String>? }
// chatId/userId 안 보냄 → LOGINLIST partial snapshot 상태에서도 linkId 만 알면 바로 발사.
export const PATH_LINK = '/c/fraud/report/link'

// ★ 2026-11-15 라이브 4-mode matrix 로 **대문자가 실제 wire format** 확정.
// 8차 Fork 의 "소문자 snake_case 가 정답" 결론은 틀림 — yud1.d(Lrg61) 가 UI label
// 또는 로컬 내부 표현을 반환했을 뿐 실제 kotlinx-serialization wire 는 enum class
// name 그대로 (대문자). 봇이 그동안 보내던 대문자가 서버에선 맞음.
// (4-mode matrix 결과: (1)(2) UPPER=status=0, (3)(4) lower=status=-500)
export const CATEGORIES = [
  'SEXUAL', 'RIGHT', 'ILLEGAL_FILMING', 'FRAUD', 'SPAM', 'SUICIDE',
  'PROTECTCHILD', 'VIOLENT', 'ILLEGAL', 'PRIVACY', 'YOUTH_UNSUITABLE', 'ETC',
]

// 욕설·혐오·폭력·증오발언 (resources.arsc + 라이브 matrix 확정).
export const PROFANITY_CATEGORY = 'VIOLENT'

// 소문자 입력 자동 대문자화 (debug 호환)
const CATEGORY_UPPER = {
  violent: 'VIOLENT', sexual: 'SEXUAL', spam: 'SPAM', fraud: 'FRAUD',
  illegal: 'ILLEGAL', privacy: 'PRIVACY', suicide: 'SUICIDE', etc: 'ETC',
  right_infringement: 'RIGHT', protect_child: 'PROTECTCHILD',
  illegal_filming: 'ILLEGAL_FILMING', youth_unsuitable: 'YOUTH_UNSUITABLE',
}
function normalizeCategory(c) {
  const s = String(c || '').trim()
  let wire = s
  if (CATEGORIES.includes(s)) wire = s
  else if (CATEGORY_UPPER[s.toLowerCase()]) wire = CATEGORY_UPPER[s.toLowerCase()]
  else {
    const up = s.toUpperCase()
    wire = CATEGORIES.includes(up) ? up : PROFANITY_CATEGORY
  }
  // 환경변수 REPORT_CATEGORY_CASE=lower 로 debug 시 소문자 snake_case 로 전환 (실험용)
  if (String(process.env.REPORT_CATEGORY_CASE || '').toLowerCase() === 'lower') {
    const low = Object.entries(CATEGORY_UPPER).find(([, u]) => u === wire)
    if (low) return low[0]
  }
  return wire
}

const GAP = 400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ADID fallback — cred 에 adid 없으면 duuid 로부터 안정적인 UUID 생성 (매 요청 같은 값).
// Node 20 미만 호환성 확보.
function adidFromDuuid(duuid) {
  // duuid 는 64 hex. 앞 32자리만 써서 UUID v4 포맷으로 조립.
  const s = String(duuid || '').replace(/-/g, '')
  if (s.length < 32) return null
  const h = s.slice(0, 32)
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32)
}

function authHeader(credOverride, opts = {}) {
  const c = credOverride || getCred()
  if (!c || !c.oauthToken) throw new Error('로그인 안 됨 (cred 없음)')
  // ★ v59-A D7 — Authorization 접미사 A/B (§12 APK vs BLSPAMS_DEBUG rp-v44 충돌).
  //   'plain'  = oauthToken 그대로 (APK c4c0.i() 리턴값)
  //   'duuid'  = oauthToken + '-' + duuid (rp-v44 재분석 결론, 라이브 72건 통과한 값)
  //   둘 다 라이브에서 접수된 적 있음. P1 프로브가 어느 쪽이 접수되는지 2회로 확정 후
  //   기본값 재조정. 그 전까지 어느 쪽도 삭제하지 않는다.
  //   ★ 결정될 때까지 호환성 유지 위해 환경변수 REPORT_AUTH_STYLE=duuid 로 즉시 전환 가능.
  const style = (opts.authStyle || process.env.REPORT_AUTH_STYLE || 'plain').toLowerCase()
  let authValue
  if (style === 'duuid') {
    if (!c.duuid) throw new Error("authStyle 'duuid' 선택인데 cred 에 duuid 없음")
    authValue = c.oauthToken + '-' + c.duuid
  } else {
    authValue = c.oauthToken
  }
  const h = {
    'authorization': authValue,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': 'KT/26.8.3 An/13 ko',
    'a': 'android/26.8.3/ko',
  }
  // ★ APK 9차 — s0.b() 가 /c/fraud/* 에 ADID 주입. 하지만 봇이 넣은 랜덤 UUID 가
  // Google 교차검증에 걸려 -500 유발 가능성. 환경변수로 모드 전환:
  //   REPORT_ADID_MODE=per_account  (디폴트, 계정별 UUID v4)
  //   REPORT_ADID_MODE=optout       (빈 문자열 — "Ad personalization opt-out" 흉내)
  //   REPORT_ADID_MODE=zeros        ("00000000-0000-0000-0000-000000000000")
  //   REPORT_ADID_MODE=off          (헤더 완전 생략 — 교정 전 상태)
  const mode = String(process.env.REPORT_ADID_MODE || 'per_account').toLowerCase()
  if (mode === 'optout') h['adid'] = ''
  else if (mode === 'zeros') h['adid'] = '00000000-0000-0000-0000-000000000000'
  else if (mode === 'off') { /* 헤더 생략 */ }
  else h['adid'] = c.adid || adidFromDuuid(c.duuid) || '00000000-0000-0000-0000-000000000000'
  if (opts.includeApkHeaders) {
    h['accept-language'] = 'ko'
    h['c'] = randomUUID()
  }
  return h
}

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
  if (v == null || v === '') return '0'
  if (typeof v === 'bigint') return v.toString()
  const s = String(v).trim()
  if (/^-?\d+$/.test(s)) return s
  return '0'
}

// ★ v59-A D2 — strict 치환 유틸. 조용한 치환 금지. 이전엔 longStr('abc') → '0' 으로
// u:0 오타가 서버에 그대로 나가고 silent-accept 되는 경로가 있었다.
// 이 유틸을 u/l/s/t/scope 에 걸어서 발사 전 throw 하면 400 으로 UI 에 반환된다.
function strictInt(v, name) {
  if (v === '' || v == null) throw new Error('strictInt ' + name + ' 누락')
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error('strictInt ' + name + ' 정수 아님: ' + JSON.stringify(v))
  if (Math.abs(n) > 2147483647) throw new Error('strictInt ' + name + ' int32 범위 초과: ' + n)
  return n
}
function strictLong(v, name) {
  if (v == null) throw new Error('strictLong ' + name + ' 누락')
  const s = String(v)
  if (!/^\d{15,20}$/.test(s)) throw new Error('strictLong ' + name + ' 형식: ' + s)
  return s
}
// §5 yud1.b — 500자 초과면 앞 500 + ' ...'. 비면 빈 문자열.
function trunc500(s) {
  const str = String(s == null ? '' : s)
  if (!str.trim()) return ''
  return str.length > 500 ? str.slice(0, 500) + ' ...' : str
}

// ★ v59-A §4 — assertShape: 발사 전 하드 게이트. 하나라도 실패하면 발사 중단.
//   reportOne/fanout/fanoutLink/fireAll/dumpRequest 전부 이 게이트를 거친다.
export function assertShape(o) {
  if (!/^\d{15,20}$/.test(String(o.u))) throw new Error('u 형식: ' + o.u)
  if (!/^\d{15,20}$/.test(String(o.l))) throw new Error('l 형식: ' + o.l)
  for (const k of ['s', 't', 'scope']) {
    if (!Number.isInteger(o[k])) throw new Error(k + ' int 아님: ' + JSON.stringify(o[k]))
  }
  const mk = Object.keys(o.m)
  for (const k of mk) {
    if (!['message', 'attachment', 'referer', 'revision'].includes(k)) throw new Error('m 키 ' + k)
  }
  const expectM = mk[0] === 'message' ? mk : ['message', ...mk]
  if (JSON.stringify(mk) !== JSON.stringify(expectM)) throw new Error('m 키 순서/누락')
  if (o.m.message != null && o.m.message.length > 504) throw new Error('500자 초과')
  const expect = ['u', 'm', 's', 't', 'l', 'scope']
  if (o.threadId != null) expect.push('threadId')
  if (JSON.stringify(Object.keys(o)) !== JSON.stringify(expect)) {
    throw new Error('키 순서/누락 expect=' + expect.join(',') + ' got=' + Object.keys(o).join(','))
  }
  return true
}

// ★ v59-A D4 — sendAt 은 chatLog.c() 원본값 그대로. 30일 컷/5분 컷 제거.
// 원래 메시지가 40일 전이라면 그 40일 전 시각이 그대로 나가야 앱 캡쳐와 일치한다.
// 서버가 타임스탬프로 cross-check 할 수도 있고, 그 경우 "now 로 치환" 은 신호가 된다.
// strictInt 로 int32 범위 검증. s <= 0 (취득 못한 메시지) 일 때만 now 로 대체.
function clampSendAt(raw) {
  const s = strictInt(raw, 'sendAt')
  return s <= 0 ? Math.floor(Date.now() / 1000) : s
}

// ★ v59-A D1/D5/D6/D8 — logItem 재작성. yud1.f + yud1.j 그대로:
//   outer 키 순서: u → m → s → t → l → scope → (threadId?)
//   m 키는 4개 조건부: message(blank 아닐 때) / attachment(길이>0) /
//     referer(null 아닐 때) / revision(null 아닐 때). 0 은 유효값으로 포함.
//   u/l strictLong, s/t/scope strictInt. scope 하드코딩 "1" 제거 — lg.scope ?? ctx.scope.
//   object 반환 → buildChatLogInfosString() 에서 assertShape 후 JSON.stringify.
//   injectText (D8): primary 만 ctx.injectText 로 덮을 수 있음. extra 는 자기 injectText 만.
function logItem(lg, isPrimary, ctx) {
  const uRaw =
    (lg.authorIdOverride != null && lg.authorIdOverride !== '') ? lg.authorIdOverride
    : (ctx && ctx.authorIdOverride != null && ctx.authorIdOverride !== '') ? ctx.authorIdOverride
    : lg.authorId
  const lRaw =
    (lg.logIdOverride != null && lg.logIdOverride !== '') ? lg.logIdOverride
    : (ctx && ctx.logIdOverride != null && ctx.logIdOverride !== '') ? ctx.logIdOverride
    : lg.logId
  const u = strictLong(uRaw, 'u')
  const l = strictLong(lRaw, 'l')
  const s = clampSendAt(lg.sendAt)
  const t = strictInt(lg.type, 't')
  const scopeRaw = lg.scope != null ? lg.scope : (ctx && ctx.scope != null ? ctx.scope : null)
  const scope = strictInt(scopeRaw, 'scope')

  // D8 — primary 만 ctx.injectText 로 덮음. extra 는 자기 injectText 아니면 원문.
  const injectEnabled = (lg.enableInject === true) || (ctx && ctx.enableInject === true)
  let rawMsg = ''
  if (injectEnabled && lg.injectText != null && String(lg.injectText).trim()) {
    rawMsg = String(lg.injectText)
  } else if (injectEnabled && isPrimary && ctx && ctx.injectText != null && String(ctx.injectText).trim()) {
    rawMsg = String(ctx.injectText)
  } else {
    rawMsg = String(lg.message || '')
  }
  const text = trunc500(rawMsg)

  // m 4키 조건부. 순서 message → attachment → referer → revision.
  const m = {}
  if (text) m.message = text
  if (lg.attachmentJson != null && String(lg.attachmentJson).length > 0) {
    m.attachment = String(lg.attachmentJson)
  }
  if (lg.referer != null) m.referer = strictInt(lg.referer, 'referer')
  if (lg.revision != null) m.revision = strictInt(lg.revision, 'revision')

  const o = { u, m, s, t, l, scope }
  // threadId — null/undefined 면 키 생략, 0 이면 "threadId":0 송출. Long 이라 15자리 제한 없음.
  const threadRaw = lg.threadId != null ? lg.threadId : (ctx && ctx.threadId != null ? ctx.threadId : null)
  if (threadRaw != null) {
    const ts = String(threadRaw)
    if (!/^\d+$/.test(ts)) throw new Error('threadId 형식: ' + ts)
    o.threadId = ts
  }
  return o
}

export function buildChatLogInfosString(ctx) {
  const items = [logItem(ctx, true, ctx)]
  if (Array.isArray(ctx.extraLogs)) {
    for (const extra of ctx.extraLogs) {
      if (!extra || (!extra.logId && !ctx.logIdOverride) || (!extra.authorId && !ctx.authorIdOverride)) continue
      items.push(logItem(extra, false, ctx))
    }
  }
  // v59-A §4 — assertShape 전량. 하나라도 실패하면 throw (buildBody caller 가 catch).
  for (const o of items) assertShape(o)
  // v59-A D3 — §5 yud1.e 역순 재조립. 앱은 마지막 index 부터 0 까지 새 JSONArray 로 복사.
  // 봇은 지금까지 primary 를 0 번에 두고 extra 가 뒤따랐는데 앱은 그 반대 순서로 보낸다.
  items.reverse()
  // u/l 은 JSON number 로, threadId 도 number 가 자연스럽지만 Long 이라 JS 정수 안전범위를
  // 넘을 수 있다. 각 값이 strictLong 통과한 숫자 문자열이므로 raw JSON 조립으로 처리.
  const encoded = items.map(encodeItem)
  return '[' + encoded.join(',') + ']'
}

// 각 logItem object 를 JSON string 으로 — Long 필드는 JSON number 로 그대로 삽입 (quote 안 함).
function encodeItem(o) {
  const parts = []
  parts.push('"u":' + o.u)
  const mParts = []
  if (o.m.message != null) mParts.push('"message":' + JSON.stringify(o.m.message))
  if (o.m.attachment != null) mParts.push('"attachment":' + JSON.stringify(o.m.attachment))
  if (o.m.referer != null) mParts.push('"referer":' + o.m.referer)
  if (o.m.revision != null) mParts.push('"revision":' + o.m.revision)
  parts.push('"m":{' + mParts.join(',') + '}')
  parts.push('"s":' + o.s)
  parts.push('"t":' + o.t)
  parts.push('"l":' + o.l)
  parts.push('"scope":' + o.scope)
  if (o.threadId != null) parts.push('"threadId":' + o.threadId)
  return '{' + parts.join(',') + '}'
}

export function buildBody(ctx, category) {
  const linkId = longStr(ctx.linkId)
  const chatId = longStr(ctx.chatId)
  const cat = jsonEscape(normalizeCategory(category))
  const infos = jsonEscape(buildChatLogInfosString(ctx))
  return {
    _raw: '{"category":"' + cat + '","linkId":' + linkId + ',"chatId":' + chatId + ',"chatLogInfos":"' + infos + '"}',
  }
}

// ★ 실제 전송 없이 "앱 신고 캡쳐와 바이트 비교" 용 덤프. frida 스크립트 출력 포맷과 동일.
export function dumpRequest(ctx, category, opts = {}) {
  const body = buildBody(ctx, category || PROFANITY_CATEGORY)
  const payload = body._raw
  const includeApkHeaders = opts.includeApkHeaders === false ? false : true
  const headers = authHeader(opts.cred, { includeApkHeaders })
  const url = HOST + PATH
  const bodyBuf = Buffer.from(payload, 'utf8')
  const hex = bodyBuf.toString('hex')
  const lines = []
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('[BOT] POST ' + url)
  const entries = Object.entries(headers)
  lines.push('--- headers (' + entries.length + ') ---')
  // frida OkHttp interceptor 체인 끝 출력 순서는 사실상 알파벳 (OkHttp Headers.Builder 내부 정렬 X — add 순서) 이라
  // 완벽 매치는 어렵지만 "값" 자체는 1:1 비교 가능. 사람 눈 diff 쉽게 이름순 정렬.
  entries.sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of entries) lines.push(k + ': ' + v)
  lines.push('--- body (' + bodyBuf.length + ' bytes, content-type=application/json; charset=UTF-8) ---')
  lines.push(payload)
  lines.push('--- body hex (' + bodyBuf.length + ') ---')
  lines.push(hex)
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  return {
    ok: true,
    url, method: 'POST',
    headers,
    body: payload,
    bodyLen: bodyBuf.length,
    bodyHex: hex,
    frida: lines.join('\n'),
  }
}

async function hit(body, { timeoutMs = 8000, host = HOST, path = PATH, cred, retries = 1, includeApkHeaders = false } = {}) {
  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const payload = body && typeof body._raw === 'string' ? body._raw : JSON.stringify(body)
    try {
      const r = await fetch(host + path, {
        method: 'POST',
        headers: authHeader(cred, { includeApkHeaders }),
        body: payload,
        signal: ctrl.signal,
      })
      const text = await r.text()
      let j = null
      try { j = JSON.parse(text) } catch (e) {}
      const headers = {}
      try { for (const [k, v] of r.headers) headers[k] = v } catch (e) {}
      const result = {
        httpCode: r.status,
        status: j && typeof j.status === 'number' ? j.status : null,
        body: j,
        text: !j ? text.slice(0, 200) : null,
        sent: payload.slice(0, 400),
        headers,
        attempt,
      }
      if (result.httpCode === 200 && result.status === 0) return result
      last = result
      if (attempt < retries) await sleep(300 + Math.floor(Math.random() * 600))
    } catch (e) {
      last = { httpCode: 0, err: String(e && e.message ? e.message : e), attempt }
      if (attempt < retries) await sleep(300 + Math.floor(Math.random() * 600))
    } finally {
      clearTimeout(t)
    }
  }
  return last || { httpCode: 0, err: 'no attempt' }
}

export async function reportOne(ctx, category, opts = {}) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  if (!ctx.linkId) return { ok: false, text: 'linkId 필요 (방을 pickRoom 으로 선택해야 자동 채워짐)' }
  // 디버그 override — opts.adidMode / opts.categoryUpper 로 환경변수 일시 오버라이드
  const saveAdid = process.env.REPORT_ADID_MODE
  const saveCat = process.env.REPORT_CATEGORY_CASE
  if (opts.adidMode) process.env.REPORT_ADID_MODE = opts.adidMode
  if (opts.categoryUpper) process.env.REPORT_CATEGORY_CASE = 'upper'
  else if (opts.categoryUpper === false) process.env.REPORT_CATEGORY_CASE = 'lower'
  try {
    const body = buildBody(ctx, category)
    const includeApkHeaders = opts.includeApkHeaders === false ? false : true
    const r = await hit(body, { cred: opts.cred, retries: opts.retries != null ? opts.retries : 1, includeApkHeaders })
    const ok = r.httpCode === 200 && r.status === 0
    return {
      ok, category, sent: r.sent, http: r.httpCode, status: r.status, respBody: r.body, respHeaders: r.headers, text: r.text, attempt: r.attempt,
      msg: (ok ? '★ 접수' : '실패') + ' category=' + category + ' http=' + r.httpCode + ' status=' + r.status + (r.err ? ' err=' + r.err : '') + (r.attempt ? ' (재시도#' + r.attempt + ')' : ''),
    }
  } finally {
    if (opts.adidMode) { if (saveAdid === undefined) delete process.env.REPORT_ADID_MODE; else process.env.REPORT_ADID_MODE = saveAdid }
    if (opts.categoryUpper !== undefined) { if (saveCat === undefined) delete process.env.REPORT_CATEGORY_CASE; else process.env.REPORT_CATEGORY_CASE = saveCat }
  }
}

// ★ 4-mode debug matrix — 어느 변수가 -500 범인인지 한 번에 확정
export async function debugMatrix(ctx, category) {
  const modes = [
    { tag: '(1) 대문자 + ADID off  (교정 전 상태)', adidMode: 'off',          categoryUpper: true },
    { tag: '(2) 대문자 + ADID on   (ADID 만 추가)',   adidMode: 'per_account', categoryUpper: true },
    { tag: '(3) 소문자 + ADID off  (category 만 교정)', adidMode: 'off',          categoryUpper: false },
    { tag: '(4) 소문자 + ADID on   (지금 상태)',       adidMode: 'per_account', categoryUpper: false },
  ]
  const rows = []
  for (const m of modes) {
    const r = await reportOne(ctx, category, { adidMode: m.adidMode, categoryUpper: m.categoryUpper, retries: 0 })
    rows.push({ ...m, http: r.http, status: r.status, ok: r.ok })
    await sleep(1500)
  }
  const lines = ['category=' + category + ' · l=' + ctx.logId + ' · 4-mode matrix', '']
  for (const r of rows) lines.push(r.tag + '  →  http=' + r.http + ' status=' + r.status + (r.ok ? ' ★' : ''))
  lines.push('')
  lines.push('※ 판정:')
  lines.push('  · (1) status=0, (2~4) != 0 → ADID 추가가 범인')
  lines.push('  · (1)(3) status=0, (2)(4) != 0 → ADID 추가가 범인 (category 무관)')
  lines.push('  · (1)(2) status=0, (3)(4) != 0 → category 소문자화가 범인')
  lines.push('  · 전부 != 0 → 둘 다 아님, 다른 원인 (attachment 등)')
  lines.push('  · (4)==0 → 현재 상태 자체 정상')
  return { ok: true, rows, text: lines.join('\n') }
}

// ★ "차단하고 신고하기" — Report POST 1회 + KICKMEM LOCO 1회 (block=true).
// KICKMEM 은 primary LOCO 세션 1개로만 (fanout 계정별 LOCO 미지원).
// 서버가 report + block 조합을 "진짜 피해자 신고" 로 판정해 심사 큐 임계 가중치 둔다는 가설.
export async function reportAndBlock(ctx, category, opts = {}) {
  const rep = await reportOne(ctx, category, opts)
  const result = { ok: rep.ok, report: rep, block: null, msg: rep.msg }
  if (!rep.ok) {
    result.msg = '(Report 실패 — KICKMEM 건너뜀) ' + rep.msg
    return result
  }
  if (!LOCO.ready()) {
    result.block = { ok: false, skipped: true, reason: 'LOCO 세션 없음 (primary 복구 필요)' }
    result.msg = rep.msg + ' / KICKMEM skip: LOCO 연결 없음'
    return result
  }
  try {
    const r = await LOCO.kickMem(ctx.linkId, ctx.chatId, ctx.authorId, true)
    const bs = r && r.body && typeof r.body.status === 'number' ? r.body.status : null
    const ok = r && r.statusCode === 0 && (bs === 0 || bs == null)
    result.block = { ok, statusCode: r && r.statusCode, status: bs, body: r && r.body }
    result.msg = rep.msg + ' / KICKMEM ' + (ok ? '★차단OK' : '실패 st=' + (r && r.statusCode) + ' b=' + bs)
    result.ok = rep.ok && ok
  } catch (e) {
    result.block = { ok: false, error: String(e && e.message ? e.message : e) }
    result.msg = rep.msg + ' / KICKMEM ERR ' + result.block.error.slice(0, 80)
  }
  return result
}

// ★ 프로필(=오픈링크 자체) 신고 — /c/fraud/report/link (APK 5차 확정).
// 바디 3필드: category · linkId · attachmentPaths?. chatId/userId 안 보냄.
// LOGINLIST partial snapshot 상황에서도 linkId 만 알면 바로 작동. 서버가 chatLogs 와
// 별도 심사 큐 쓸 가능성 매우 큼 — silent-accept 돌파 결정적 후보.
export function buildLinkBody(linkId, category, attachmentPaths) {
  const linkStr = longStr(linkId)
  const cat = jsonEscape(normalizeCategory(category))
  // kotlinx-serialization 선언 순서: category → linkId → attachmentPaths
  // attachmentPaths 는 nullable — 비어있을 때 생략 (public 신고는 첨부 없음)
  let raw
  if (Array.isArray(attachmentPaths) && attachmentPaths.length) {
    const arr = attachmentPaths.map((p) => '"' + jsonEscape(String(p)) + '"').join(',')
    raw = '{"category":"' + cat + '","linkId":' + linkStr + ',"attachmentPaths":[' + arr + ']}'
  } else {
    raw = '{"category":"' + cat + '","linkId":' + linkStr + '}'
  }
  return { _raw: raw }
}

export async function reportLink(linkId, category, opts = {}) {
  if (!linkId) return { ok: false, text: 'linkId 필요' }
  const body = buildLinkBody(linkId, category, opts.attachmentPaths)
  const includeApkHeaders = opts.includeApkHeaders === false ? false : true
  const r = await hit(body, {
    cred: opts.cred,
    path: PATH_LINK,
    retries: opts.retries != null ? opts.retries : 1,
    includeApkHeaders,
  })
  const ok = r.httpCode === 200 && r.status === 0
  return {
    ok, category, path: PATH_LINK, sent: r.sent, http: r.httpCode, status: r.status,
    respBody: r.body, respHeaders: r.headers, text: r.text, attempt: r.attempt,
    msg: (ok ? '★ 프로필접수' : '실패') + ' category=' + category + ' linkId=' + linkId
      + ' http=' + r.httpCode + ' status=' + r.status
      + (r.err ? ' err=' + r.err : '') + (r.attempt ? ' (재시도#' + r.attempt + ')' : ''),
  }
}

// 프로필 신고 + KICKMEM 체인 (반드시 chatId/targetUserId 필요 — KICKMEM 용).
// linkId 만 있어도 Report 는 되지만 차단은 chatId/mid 필요.
export async function reportLinkAndBlock({ linkId, chatId, targetUserId }, category, opts = {}) {
  const rep = await reportLink(linkId, category, opts)
  const result = { ok: rep.ok, report: rep, block: null, msg: rep.msg }
  if (!rep.ok) { result.msg = '(Report 실패 — KICKMEM 건너뜀) ' + rep.msg; return result }
  if (!chatId || !targetUserId) {
    result.block = { ok: false, skipped: true, reason: 'chatId/targetUserId 없음 (KICKMEM 생략)' }
    return result
  }
  if (!LOCO.ready()) {
    result.block = { ok: false, skipped: true, reason: 'LOCO 세션 없음' }
    result.msg = rep.msg + ' / KICKMEM skip: LOCO 연결 없음'
    return result
  }
  try {
    const r = await LOCO.kickMem(linkId, chatId, targetUserId, true)
    const bs = r && r.body && typeof r.body.status === 'number' ? r.body.status : null
    const ok = r && r.statusCode === 0 && (bs === 0 || bs == null)
    result.block = { ok, statusCode: r && r.statusCode, status: bs, body: r && r.body }
    result.msg = rep.msg + ' / KICKMEM ' + (ok ? '★차단OK' : '실패 st=' + (r && r.statusCode) + ' b=' + bs)
    result.ok = rep.ok && ok
  } catch (e) {
    result.block = { ok: false, error: String(e && e.message ? e.message : e) }
    result.msg = rep.msg + ' / KICKMEM ERR ' + result.block.error.slice(0, 80)
  }
  return result
}

// ★ 각 계정이 "자기 KICKMEM" 호출 — APK 6차 재현.
// primary 는 report-loco.mjs (상시 세션), fanout 추가 계정은 report-loco-pool.mjs (lazy).
// 반환: { ok, status, err, source:'primary'|'pool'|'skip' }
async function _perAccountKickMem(account, linkId, chatId, targetUserId) {
  if (!chatId || !targetUserId) return { ok: false, skipped: true, source: 'skip', reason: 'chatId/targetUserId 없음' }
  // primary 는 상시 세션 사용 (report-loco)
  const primaryAcc = await (async () => {
    try { const list = await DB.listAccounts(); return list.find((a) => a.isPrimary) } catch (e) { return null }
  })()
  const isPrimary = primaryAcc && String(primaryAcc.userId) === String(account.userId)
  try {
    const r = isPrimary && LOCO.ready()
      ? await LOCO.kickMem(linkId, chatId, targetUserId, true)
      : await POOL.kickMem(account.userId, linkId, chatId, targetUserId, true)
    const bs = r && r.body && typeof r.body.status === 'number' ? r.body.status : null
    const ok = r && r.statusCode === 0 && (bs === 0 || bs == null)
    return { ok, statusCode: r && r.statusCode, status: bs, source: isPrimary ? 'primary' : 'pool' }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 180), source: isPrimary ? 'primary' : 'pool' }
  }
}

// 활성 계정 전부로 /link 발사 (fanout). 필요 param = linkId. chatId/targetUserId 는 postBlock 때만 필요.
// postBlock=true: 각 계정이 자기 report 성공 직후 자기 KICKMEM 호출 (APK UX 재현).
export async function fanoutLink({ linkId, chatId, targetUserId }, category, userIds, { gapMs = 2500, jitterMs = 1500, shuffle = true, postBlock = false } = {}) {
  if (!linkId) return { ok: false, text: 'linkId 필요' }
  const cat = category || PROFANITY_CATEGORY
  const all = await DB.listAccounts()
  const active = all.filter((a) => a.active !== false && a.oauthToken && a.duuid)
  let list = userIds && userIds.length ? active.filter((a) => userIds.map(String).includes(String(a.userId))) : active.slice()
  if (!list.length) return { ok: false, text: '발사 가능한 활성 계정이 없음' }
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
  }
  const rows = []
  let accepted = 0
  let blockOk = 0, blockSkip = 0
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const r = await reportLink(linkId, cat, { cred: a }).catch((e) => ({ ok: false, http: 0, status: null, err: String(e && e.message ? e.message : e) }))
    const status = r.status != null ? r.status : (r.err ? 'err' : '-')
    // 각 계정이 자기 KICKMEM (postBlock 시)
    let blk = null
    if (postBlock && r.ok) {
      blk = await _perAccountKickMem(a, linkId, chatId, targetUserId)
      if (blk.ok) blockOk++
      else if (blk.skipped) blockSkip++
    }
    try { await DB.markAccountUsed(a.userId, 'link http=' + r.http + ' s=' + status + (blk ? ' kick=' + (blk.ok ? 'ok' : blk.skipped ? 'skip' : 'fail') : '')) } catch (e) {}
    rows.push({
      userId: a.userId,
      email: String(a.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
      ok: !!r.ok, http: r.http, status: r.status, err: r.err || null, kick: blk,
      msg: (r.ok ? '★' : '·') + ' ' + a.userId + ' http=' + r.http + ' s=' + status
        + (blk ? ' / KICKMEM ' + (blk.ok ? '★' + blk.source : blk.skipped ? 'skip(' + blk.reason + ')' : 'fail ' + (blk.error || 's=' + blk.statusCode + '/b=' + blk.status)) : ''),
    })
    if (r.ok) accepted++
    if (i + 1 < list.length) await sleep(gapMs + Math.floor(Math.random() * (jitterMs || 0)))
  }
  // v59-A D12 — blockFail 을 accepted 기준으로. 이전엔 list.length 기준이라
  // 접수 실패한 계정까지 "차단 실패" 로 세서 UI 가 과대 보고했다. fanout() 쪽과 동일.
  const postBlockSummary = postBlock
    ? (chatId && targetUserId
        ? { perAccount: true, blockOk, blockSkip, blockFail: accepted - blockOk - blockSkip, total: list.length }
        : { skipped: true, reason: 'chatId/targetUserId 없음' })
    : null
  const postBlockLine = postBlockSummary
    ? '\nKICKMEM 각 계정: ' + (postBlockSummary.skipped
        ? 'skip (' + postBlockSummary.reason + ')'
        : '★성공 ' + postBlockSummary.blockOk + '/' + postBlockSummary.total
          + (postBlockSummary.blockSkip ? ' · skip ' + postBlockSummary.blockSkip : '')
          + (postBlockSummary.blockFail ? ' · fail ' + postBlockSummary.blockFail : ''))
    : ''
  return {
    ok: accepted > 0, accepted, total: list.length, rows, gapMs, jitterMs, shuffled: shuffle, postBlock: postBlockSummary,
    text: '프로필 fanout 접수 ' + accepted + '/' + list.length + ' category=' + cat + ' linkId=' + linkId + '\n' + rows.map((x) => x.msg).join('\n') + postBlockLine,
  }
}

export async function fireAll(ctx) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  const ordered = [PROFANITY_CATEGORY, ...CATEGORIES.filter((c) => c !== PROFANITY_CATEGORY)]
  const results = []
  const BATCH = 3
  for (let i = 0; i < ordered.length; i += BATCH) {
    const chunk = ordered.slice(i, i + BATCH)
    const rs = await Promise.all(chunk.map((cat) => reportOne(ctx, cat)))
    rs.forEach((r) => { results.push(r); console.log('openchat fireAll ' + JSON.stringify(r)) })
    if (i + BATCH < ordered.length) await sleep(GAP)
  }
  const rows = results.map((r) => r.category + ' → http=' + r.http + (r.status != null ? '/s=' + r.status : '') + (r.text ? ' "' + String(r.text).slice(0, 80) + '"' : ''))
  const acceptedCats = results.filter((r) => r.ok).map((r) => r.category)
  return { ok: acceptedCats.length > 0, accepted: acceptedCats.length, acceptedCats, rows, text: '접수 ' + acceptedCats.length + '/' + ordered.length + ' [' + acceptedCats.join(',') + ']\n' + rows.join('\n') }
}

// v59-A D13 — probeHosts / probeShapes 는 reportOne 을 한 번 부를 뿐 탐색이 전혀 없었다.
// 호스트는 §8 로 open.kakao.com 단일 확정, 바디 모양은 §9 로 완전 확정. 남겨 두면
// "탐색 중" 이라는 오해만 생긴다. UI 에서 호출 흔적도 없음. 함수와 라우트 전부 제거.

export async function fanout(ctx, category, userIds, { gapMs = 2500, jitterMs = 1500, shuffle = true, warmupFn = null, postBlock = false } = {}) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId || !ctx.linkId) {
    return { ok: false, text: 'chatId · logId · authorId · linkId 필요' }
  }
  const cat = category || PROFANITY_CATEGORY
  const all = await DB.listAccounts()
  const active = all.filter((a) => a.active !== false && a.oauthToken && a.duuid)
  let list = userIds && userIds.length ? active.filter((a) => userIds.map(String).includes(String(a.userId))) : active.slice()
  if (!list.length) return { ok: false, text: '발사 가능한 활성 계정이 없음' }
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
  }
  let warmupNote = ''
  if (typeof warmupFn === 'function') {
    try { const ok = await warmupFn(); warmupNote = ok ? '[warmup✓] ' : '[warmup✗] ' } catch (e) { warmupNote = '[warmup✗] ' }
  }
  const rows = []
  let accepted = 0
  let blockOk = 0, blockSkip = 0
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const r = await reportOne(ctx, cat, { cred: a }).catch((e) => ({ ok: false, http: 0, status: null, err: String(e && e.message ? e.message : e) }))
    const status = r.status != null ? r.status : (r.err ? 'err' : '-')
    // 각 계정이 자기 KICKMEM (postBlock 시) — APK UX 재현
    let blk = null
    if (postBlock && r.ok) {
      blk = await _perAccountKickMem(a, ctx.linkId, ctx.chatId, ctx.authorId)
      if (blk.ok) blockOk++
      else if (blk.skipped) blockSkip++
    }
    try { await DB.markAccountUsed(a.userId, 'http=' + r.http + ' s=' + status + (blk ? ' kick=' + (blk.ok ? 'ok' : blk.skipped ? 'skip' : 'fail') : '')) } catch (e) {}
    rows.push({
      userId: a.userId,
      email: String(a.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
      ok: !!r.ok, http: r.http, status: r.status, err: r.err || null, kick: blk,
      msg: (r.ok ? '★' : '·') + ' ' + a.userId + ' http=' + r.http + ' s=' + status
        + (blk ? ' / KICKMEM ' + (blk.ok ? '★' + blk.source : blk.skipped ? 'skip(' + blk.reason + ')' : 'fail ' + (blk.error || 's=' + blk.statusCode + '/b=' + blk.status)) : ''),
    })
    if (r.ok) accepted++
    if (i + 1 < list.length) await sleep(gapMs + Math.floor(Math.random() * (jitterMs || 0)))
  }
  const postBlockSummary = postBlock
    ? { perAccount: true, blockOk, blockSkip, blockFail: accepted - blockOk - blockSkip, total: list.length }
    : null
  const postBlockLine = postBlockSummary
    ? '\nKICKMEM 각 계정: ★성공 ' + postBlockSummary.blockOk + '/' + postBlockSummary.total
        + (postBlockSummary.blockSkip ? ' · skip ' + postBlockSummary.blockSkip : '')
        + (postBlockSummary.blockFail > 0 ? ' · fail ' + postBlockSummary.blockFail : '')
    : ''
  return {
    ok: accepted > 0, accepted, total: list.length, rows, gapMs, jitterMs, shuffled: shuffle, postBlock: postBlockSummary,
    text: warmupNote + 'fanout 접수 ' + accepted + '/' + list.length + ' category=' + cat + ' (간격 ' + gapMs + '~' + (gapMs + (jitterMs || 0)) + 'ms, shuffle=' + shuffle + ')\n' + rows.map((x) => x.msg).join('\n') + postBlockLine,
  }
}

// ★ 진단: 같은 logId 를 원본/주입 두 번 쏴서 서버 cross-check 여부 판별
export async function diagnoseContentMatch(ctx, opts = {}) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId || !ctx.linkId) return { ok: false, text: 'chatId · logId · authorId · linkId 필요' }
  const injected = String(ctx.injectText || '[진단용 주입 문장]')
  const cat = opts.category || PROFANITY_CATEGORY
  const cred = opts.cred
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const a = await reportOne({ ...ctx, injectText: '', enableInject: false }, cat, { cred })
  await sleep(1200 + Math.floor(Math.random() * 800))
  const b = await reportOne({ ...ctx, injectText: injected, enableInject: true }, cat, { cred })
  await sleep(1200)

  const verdict = (() => {
    if (a.http === 200 && a.status === 0 && b.http === 200 && b.status === 0) return 'NO_CROSSCHECK'
    if (a.http === 200 && a.status === 0 && !(b.http === 200 && b.status === 0)) return 'CROSSCHECK_DETECTED'
    if (!(a.http === 200 && a.status === 0) && b.http === 200 && b.status === 0) return 'UNEXPECTED'
    return 'BOTH_FAIL'
  })()
  return {
    ok: true, verdict,
    original: { http: a.http, status: a.status, sent: a.sent, resp: a.respBody, text: a.text },
    injected: { http: b.http, status: b.status, sent: b.sent, resp: b.respBody, text: b.text },
    text: verdict + '\n(a) 원본: http=' + a.http + '/s=' + a.status + '\n(b) 주입: http=' + b.http + '/s=' + b.status,
  }
}

// v59-A D13 — fire(ctx, reasons). host 인자 제거 (§8 단일 호스트 확정).
export async function fire(ctx, reasons) {
  const cats = Array.isArray(reasons) && reasons.length ? reasons.map((i) => CATEGORIES[Number(i)] || PROFANITY_CATEGORY) : CATEGORIES
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
