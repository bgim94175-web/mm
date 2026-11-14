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

export const HOST = 'https://open.kakao.com'
export const PATH = '/c/fraud/report/chatLogs'

// APK Lrg61 enum. sr 0~11 과 그 enum 이름 매핑.
export const CATEGORIES = [
  'SEXUAL', 'RIGHT', 'ILLEGAL_FILMING', 'FRAUD', 'SPAM', 'SUICIDE',
  'PROTECTCHILD', 'VIOLENT', 'ILLEGAL', 'PRIVACY', 'YOUTH_UNSUITABLE', 'ETC',
]

const GAP = 1500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function authHeader() {
  const c = getCred()
  if (!c || !c.oauthToken) throw new Error('로그인 안 됨')
  return {
    authorization: c.oauthToken + '-' + c.duuid,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'KT/26.8.3 An/13 ko',
    'a': 'android/26.8.3/ko',
  }
}

// chatLogInfos 는 **문자열** (JSON 배열을 toString 한 것). 각 원소 모양:
//   { u: userId(long), m: {message, referer, revision}, s: sendAt(int),
//     t: type(int), l: logId(long), scope: int, threadId: long|null }
export function buildChatLogInfosString(ctx) {
  const entry = {
    u: Number(ctx.authorId) || 0,
    m: {
      message: String(ctx.message || ''),
      referer: 0,
      revision: 0,
    },
    s: Number(ctx.sendAt) || 0,
    t: Number(ctx.type) || 1,
    l: Number(ctx.logId) || 0,
    scope: 1,
  }
  return JSON.stringify([entry])
}

export function buildBody(ctx, category) {
  return {
    category: String(category || 'SPAM'),
    linkId: Number(ctx.linkId) || 0,
    chatId: Number(ctx.chatId) || 0,
    chatLogInfos: buildChatLogInfosString(ctx),
  }
}

async function hit(body, { timeoutMs = 8000, host = HOST } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(host + PATH, {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch (e) {}
    return { httpCode: r.status, status: j && typeof j.status === 'number' ? j.status : null, body: j, text: !j ? text.slice(0, 200) : null }
  } catch (e) {
    return { httpCode: 0, err: String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(t)
  }
}

// 한 카테고리로 한 번 쏘기
export async function reportOne(ctx, category) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  const body = buildBody(ctx, category)
  const r = await hit(body)
  const ok = r.httpCode === 200 && r.status === 0
  return {
    ok, category, body, http: r.httpCode, status: r.status, respBody: r.body, text: r.text,
    msg: (ok ? '★ 접수' : '실패') + ' category=' + category + ' http=' + r.httpCode + ' status=' + r.status + (r.err ? ' err=' + r.err : ''),
  }
}

// 12개 카테고리 전부 때려서 어느 게 접수되는지 (한 번씩, GAP 간격)
export async function fireAll(ctx) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  const rows = []
  let accepted = 0
  let acceptedCats = []
  for (const cat of CATEGORIES) {
    const r = await reportOne(ctx, cat)
    rows.push(cat + ' → http=' + r.http + (r.status != null ? '/s=' + r.status : '') + (r.text ? ' "' + r.text.slice(0, 80) + '"' : ''))
    console.log('openchat fireAll ' + JSON.stringify(r))
    if (r.ok) { accepted += 1; acceptedCats.push(cat) }
    await sleep(GAP)
  }
  return { ok: accepted > 0, accepted, acceptedCats, rows, text: '접수 ' + accepted + '/' + CATEGORIES.length + ' [' + acceptedCats.join(',') + ']\n' + rows.join('\n') }
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
