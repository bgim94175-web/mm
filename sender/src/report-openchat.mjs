// 오픈채팅 "신고하고 나가기" HTTP 경로.
// APK 26.8.3 디컴파일로 확인된 경로: OlkChatroomAbuseReportApiParams →
//   AbuseReportViewModel.submitOlkChatroomReport → AbuseReportOlkChatroomUseCase
//   → POST c/fraud/report/chatLogs
// BLSPAMS 는 일반(1:1·단체) 채팅방 전용. 오픈채팅은 이 HTTP 가 **진짜 경로**.
import { get as getCred } from './report-auth.mjs'

// 호스트 미확정 — 카카오의 c/… API 는 보통 talk·katalk·dn-m·open 중 하나.
// 하나씩 때려봐서 200/정상 json 돌려주는 걸 찾는다.
export const HOST_CANDIDATES = [
  'https://talk.kakao.com',
  'https://katalk.kakao.com',
  'https://open.kakao.com',
  'https://dn-m.talk.kakao.com',
]

const PATH = '/c/fraud/report/chatLogs'
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

async function hit(host, body, { timeoutMs = 8000 } = {}) {
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

// APK 의 OlkChatroomAbuseReportApiParams 모양이 정확히 뭔지는 확정 못함 (사용자 agent 가 외형만 제시).
// 가장 그럴듯한 바디 몇 개 조합으로 시도.
function buildBodies({ linkId, chatId, logId, authorId, message, type, sendAt, reason }) {
  const logEntry = {
    logId: String(logId),
    chatId: String(chatId),
    userId: String(authorId),
    type: Number(type) || 1,
    sendAt: Number(sendAt) || 0,
    message: String(message || ''),
  }
  const base = {
    linkId: String(linkId || '0'),
    chatRoomId: String(chatId),
    reason: Number(reason) || 0,
  }
  return [
    {
      tag: 'shape-A chatLogs:[full]',
      body: { ...base, chatLogs: [logEntry] },
    },
    {
      tag: 'shape-B chatLogs:[id]',
      body: { ...base, chatLogs: [{ logId: String(logId), chatId: String(chatId) }] },
    },
    {
      tag: 'shape-C logs:[full]',
      body: { ...base, logs: [logEntry] },
    },
    {
      tag: 'shape-D flatten',
      body: { linkId: String(linkId || '0'), chatRoomId: String(chatId), chatLogs: [logEntry], reportReason: Number(reason) || 0 },
    },
    {
      tag: 'shape-E full+inviter',
      body: { ...base, chatLogs: [logEntry], blockInviter: false },
    },
  ]
}

// 호스트 + 바디 매트릭스 — 처음엔 호스트 1개씩 가장 단순한 바디로 scanning
export async function probeHosts(ctx) {
  if (!ctx || !ctx.chatId || !ctx.logId || !ctx.authorId) return { ok: false, text: 'chatId · logId · authorId 필요' }
  const body = {
    linkId: String(ctx.linkId || '0'),
    chatRoomId: String(ctx.chatId),
    chatLogs: [{
      logId: String(ctx.logId),
      chatId: String(ctx.chatId),
      userId: String(ctx.authorId),
      type: Number(ctx.type) || 1,
      sendAt: Number(ctx.sendAt) || 0,
      message: String(ctx.message || ''),
    }],
    reason: 0,
  }
  const rows = []
  let winnerHost = null
  for (const h of HOST_CANDIDATES) {
    const r = await hit(h, body)
    rows.push(h + ' → ' + r.httpCode + (r.status != null ? '/s=' + r.status : '') + (r.err ? ' ' + r.err : '') + (r.text ? ' "' + r.text.slice(0, 60) + '"' : ''))
    console.log('openchat report probe ' + h + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
    if (r.httpCode === 200 && r.status === 0) {
      winnerHost = h
      return { ok: true, host: h, rows, text: '★ 성공 호스트=' + h + '\n' + rows.join('\n'), lastBody: r.body }
    }
    if (r.httpCode === 200 && r.status != null && r.status !== 0) {
      // HTTP 200 + status != 0 → 경로는 맞음, 바디·권한 문제. 더 안 쏘고 이 호스트로 고정.
      winnerHost = h
      break
    }
  }
  if (winnerHost) {
    return { ok: false, host: winnerHost, rows, text: '경로 유력 호스트=' + winnerHost + '\n' + rows.join('\n') + '\n→ shape 탐색 필요' }
  }
  return { ok: false, rows, text: '모든 호스트 거부\n' + rows.join('\n') + '\n→ 다른 base URL 필요 (api.kakao.com · openlink.kakao.com 등)' }
}

// 호스트가 정해졌으면 그 호스트로 바디 변형 탐색
export async function probeShapes(host, ctx) {
  if (!host) return { ok: false, text: 'host 필요' }
  const bodies = buildBodies({
    linkId: ctx.linkId, chatId: ctx.chatId, logId: ctx.logId, authorId: ctx.authorId,
    message: ctx.message, type: ctx.type, sendAt: ctx.sendAt, reason: 0,
  })
  const rows = []
  let winner = null
  for (const b of bodies) {
    const r = await hit(host, b.body)
    rows.push(b.tag + ' → ' + r.httpCode + (r.status != null ? '/s=' + r.status : '') + (r.err ? ' ' + r.err : '') + (r.text ? ' "' + r.text.slice(0, 60) + '"' : ''))
    console.log('openchat shape ' + b.tag + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
    if (r.httpCode === 200 && r.status === 0 && !winner) winner = { tag: b.tag, body: b.body }
  }
  if (winner) return { ok: true, winner: winner.tag, rows, text: '★ 통과 바디=' + winner.tag + '\n' + rows.join('\n') }
  return { ok: false, rows, text: '모든 바디 거부\n' + rows.join('\n') }
}

// 실제 발사 — 호스트·바디 모양 확정된 뒤
export async function fire(host, ctx, reasons) {
  if (!host) return { ok: false, text: 'host 필요' }
  const srList = Array.isArray(reasons) && reasons.length ? reasons : [0, 1, 2, 3, 4, 5]
  const rows = []
  let accepted = 0
  for (const sr of srList) {
    const body = {
      linkId: String(ctx.linkId || '0'),
      chatRoomId: String(ctx.chatId),
      chatLogs: [{
        logId: String(ctx.logId),
        chatId: String(ctx.chatId),
        userId: String(ctx.authorId),
        type: Number(ctx.type) || 1,
        sendAt: Number(ctx.sendAt) || 0,
        message: String(ctx.message || ''),
      }],
      reason: sr,
    }
    const r = await hit(host, body)
    const ok = r.httpCode === 200 && r.status === 0
    if (ok) accepted += 1
    rows.push('sr' + sr + ' → ' + r.httpCode + (r.status != null ? '/s=' + r.status : '') + (r.err ? ' ' + r.err : ''))
    console.log('openchat fire sr=' + sr + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
  }
  return { ok: accepted > 0, count: accepted, rows, text: '실제 접수 ' + accepted + '/' + rows.length + '\n' + rows.join('\n') }
}
