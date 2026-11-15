// LOCO 로 방 목록·최근 메시지 가져오기. 사람이 손으로 chat_id / log_id 를 못 뜰 때 쓴다.
import { send, ready, loginResult } from './report-loco.mjs'

async function longOf() {
  try { return (await import('bson')).Long } catch (e) {}
  throw new Error('Long 없음 — npm install bson')
}

function toIdString(v) {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (typeof v === 'object' && 'low' in v && 'high' in v) {
    const low = BigInt.asUintN(32, BigInt(v.low))
    const high = BigInt(v.high)
    return String((high << 32n) | low)
  }
  if (typeof v.toString === 'function') return v.toString()
  return ''
}

function chatTypeName(t) {
  switch (Number(t)) {
    case 0: return 'Memo'
    case 1: return 'DM'
    case 2: return 'Group'
    case 3: return 'OpenGroup'
    case 32: case 33: case 34: return 'OpenMulti'
    case 15: return 'OpenDirect'
    default: return 'T' + t
  }
}

// ★ v59-A D0: chatLog 하나를 UI/신고용 공통 shape 로 — 값 없으면 null.
// 이전엔 referer/revision 을 0 으로 폴백해서 신고 바디에 "referer":0 가 강제로 붙었다.
// APK yud1.j 는 Integer 가 null 이면 키를 아예 안 넣는다 → 그 조건과 구분하려 null 유지.
// attachmentJson 은 object 로 와도 string 으로 와도 null-safe. 길이 0 이면 null.
function toAttachmentJson(raw) {
  if (raw == null) return null
  if (typeof raw === 'string') return raw.length > 0 ? raw : null
  if (typeof raw === 'object') {
    try { return Object.keys(raw).length ? JSON.stringify(raw) : null } catch (e) { return null }
  }
  return null
}
export function extractItem(log) {
  const text = typeof log.message === 'string' ? log.message : ''
  const sendAtN = Number(log.sendAt)
  const typeN = Number(log.type)
  const scopeN = Number(log.scope)
  return {
    logId: toIdString(log.logId),
    authorId: toIdString(log.authorId),
    type: Number.isFinite(typeN) ? typeN : null,
    sendAt: Number.isFinite(sendAtN) && sendAtN > 0 ? sendAtN : null,
    message: text.slice(0, 200),
    // v59-A D0: 원본값 (yud1.f/j 와 동일 조건으로 송신하기 위해 null 유지)
    attachmentJson: toAttachmentJson(log.attachment),
    referer: log.referer != null ? Number(log.referer) : (log.ref != null ? Number(log.ref) : null),
    revision: log.revision != null ? Number(log.revision) : (log.rev != null ? Number(log.rev) : null),
    scope: Number.isInteger(scopeN) ? scopeN : null,
    threadId: log.threadId != null ? toIdString(log.threadId) : null,
    nick: '',  // messages() 가 MEMBER 응답으로 채움
  }
}

// LCHATLIST paginate — LOGINLIST 가 partial snapshot(chatDatas 비게) 돌려줄 때
// agent-messenger client.getChats() 가 내부적으로 쓰는 공식 복구 경로.
// 새로 등록된 기기는 LOGINLIST 가 eof=true 로 빈 리스트 → LCHATLIST 로 canonical
// chat list 수동 조회 (device history 와 무관).
async function fetchAllChatsViaLchatlist() {
  const L = await longOf()
  const MAX_PAGES = 20
  const all = []
  let lastTokenId = L.fromNumber(0)
  let lastChatId = L.fromNumber(0)
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await send('LCHATLIST', {
      chatIds: [],
      maxIds: [],
      lastTokenId,
      lastChatId,
    })
    if (!r || r.statusCode !== 0) throw new Error('LCHATLIST st=' + (r && r.statusCode))
    const b = r.body || {}
    const chats = Array.isArray(b.chatDatas) ? b.chatDatas : []
    for (const c of chats) all.push(c)
    if (b.eof === true) break
    if (chats.length === 0) break
    if (b.lastTokenId != null) {
      lastTokenId = typeof b.lastTokenId === 'object' ? b.lastTokenId : L.fromString(String(b.lastTokenId))
    }
    if (b.lastChatId != null) {
      lastChatId = typeof b.lastChatId === 'object' ? b.lastChatId : L.fromString(String(b.lastChatId))
    }
  }
  return all
}

// 로그인 뒤 서버가 LOGINLIST 에 담아 준 방 목록 (+ 비어있으면 LCHATLIST 폴백)
export async function rooms() {
  if (!ready()) {
    return {
      ok: false, loco: false, count: 0, rooms: [],
      text: 'LOCO 세션 없음 — 방 목록은 LOGINLIST 에 담겨 오므로 LOCO 가 반드시 열려야 함.\n'
        + '· 상단 "LOCO 재연결" 버튼 눌러보기 (성공하면 바로 뜸)\n'
        + '· 그래도 실패면 폰 카카오톡 로그아웃 후 다시 "LOCO 재연결"',
    }
  }
  const lr = loginResult()
  let chatDatas = (lr && Array.isArray(lr.chatDatas)) ? lr.chatDatas : []
  let source = 'LOGINLIST'
  // partial snapshot 폴백 — LOGINLIST 가 비면 LCHATLIST 로 직접 조회
  if (chatDatas.length === 0) {
    try {
      const fetched = await fetchAllChatsViaLchatlist()
      if (fetched.length) { chatDatas = fetched; source = 'LCHATLIST(폴백)' }
    } catch (e) {
      return {
        ok: false, loco: true, count: 0, rooms: [],
        text: '방 0개 — LOGINLIST 비었고 LCHATLIST 폴백도 실패: ' + (e && e.message ? e.message : e)
          + '\n· chatId/linkId 알면 하단 섹션에서 수동 입력 가능',
      }
    }
    if (chatDatas.length === 0) {
      return {
        ok: true, loco: true, count: 0, rooms: [], source: 'LCHATLIST(empty)',
        text: '방 0개 — LCHATLIST 도 빈 리스트. 이 primary 계정은 정말 참여 방이 없거나 서버가 이 기기를 완전 격리 중.'
          + '\n· 폰 카카오톡에서 방 리스트 리프레시 후 "LOCO 재연결"'
          + '\n· 또는 chatId/linkId 알고 있으면 하단 섹션에서 수동 입력',
      }
    }
  }
  const items = chatDatas.map((c) => {
    const lastLog = c.l && typeof c.l === 'object' ? c.l : null
    const msg = lastLog && typeof lastLog.message === 'string' ? lastLog.message : ''
    const members = Array.isArray(c.k) ? c.k.slice(0, 3).join(', ') : ''
    return {
      chatId: toIdString(c.c),
      linkId: toIdString(c.li),
      type: Number(c.t),
      typeName: chatTypeName(c.t),
      activeMembers: Number(c.a) || 0,
      lastLogId: toIdString(c.ll),
      members,
      memberIds: Array.isArray(c.i) ? c.i.map(toIdString) : [],
      preview: msg.slice(0, 80),
    }
  })
  // 최근 활동(마지막 로그 id) 큰 순으로
  items.sort((a, b) => {
    const A = BigInt(a.lastLogId || '0'), B = BigInt(b.lastLogId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  return { ok: true, count: items.length, rooms: items, source, text: '방 ' + items.length + '개 (source=' + source + ')' }
}

// ★ chatId 하나만 알아도 방 정보 복구 — LOGINLIST 가 partial snapshot 돌려줘서
// 방 목록이 비어 있을 때 사용자가 수동으로 chatId 입력해서 쓰는 폴백.
// CHATINFO 응답의 chatInfo.li 가 linkId, 나머지는 메타. 그대로 UI 의 pickedRoom 처럼 세팅.
export async function lookupRoomByChatId(chatId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음 — 상단 "LOCO 재연결" 먼저' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  try {
    const r = await send('CHATINFO', { chatId: cid })
    if (!r || r.statusCode !== 0) {
      return { ok: false, text: 'CHATINFO 실패 st=' + (r && r.statusCode) + ' body=' + JSON.stringify(r && r.body || {}).slice(0, 200) }
    }
    const ci = r.body && r.body.chatInfo
    if (!ci) return { ok: false, text: 'CHATINFO 응답에 chatInfo 없음 (방이 없거나 이미 나감)' }
    const linkId = ci.li != null ? toIdString(ci.li) : ''
    const type = Number(ci.t)
    const typeName = chatTypeName(type)
    return {
      ok: true,
      room: {
        chatId: toIdString(ci.chatId != null ? ci.chatId : chatId),
        linkId,
        type, typeName,
        activeMembers: Number(ci.a) || 0,
        lastLogId: toIdString(ci.lastLogId),
        memberIds: Array.isArray(ci.i) ? ci.i.map(toIdString) : [],
        preview: '',
      },
      text: typeName + ' / linkId=' + (linkId || '(없음 — 일반채팅일수 있음)'),
    }
  } catch (e) {
    return { ok: false, text: 'CHATINFO ERR ' + (e && e.message ? e.message : e) }
  }
}

// 방 하나의 최근 메시지.
//   ① CHATINFO → 방의 최신 lastLogId (max)
//   ② SYNCMSG 이분탐색: SYNCMSG 는 "cur 이후 오름차순 최대 ~80개" 를 준다.
//      카카오 logId 는 1씩 늘지 않고 간격이 수천억대라, max-N 같은 산술 점프는
//      그 사이에 로그가 없어 빈 결과가 된다. 그래서 "비지 않는 가장 큰 cur"
//      을 이분탐색으로 찾으면 그 응답이 곧 방의 최신 묶음이 된다.
//   ③ 폴백: MCHATLOGS (봇 로컬 캐시 — 과거만)
export async function messages(chatId, cnt) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const n = Math.max(1, Math.min(80, Number(cnt) || 15))
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const trace = []

  // ① CHATINFO → max
  let maxLogId = null
  try {
    const info = await send('CHATINFO', { chatId: cid })
    trace.push('CHATINFO st=' + (info && info.statusCode))
    const ci = info && info.body && info.body.chatInfo
    if (ci && ci.lastLogId != null) {
      const s = toIdString(ci.lastLogId)
      if (s && s !== '0') maxLogId = L.fromString(s)
    }
  } catch (e) {
    trace.push('CHATINFO ERR ' + (e && e.message ? e.message : e))
  }

  // ② SYNCMSG 이분탐색으로 최신 묶음
  let logs = []
  if (maxLogId) {
    try {
      const maxBig = BigInt(toIdString(maxLogId))
      const syncAt = async (curBig) => {
        const c = curBig < 0n ? 0n : curBig
        const r = await send('SYNCMSG', { chatId: cid, cur: L.fromString(String(c)), cnt: n, max: maxLogId })
        const arr = (r && r.statusCode === 0 && r.body && Array.isArray(r.body.chatLogs)) ? r.body.chatLogs : []
        return arr.filter((lg) => toIdString(lg.chatId) === String(chatId))
      }
      // 해상도 = 로그 한 개분 간격의 대략치. 이보다 좁혀지면 종료.
      const RES = 200000000000n
      let lo = 0n, hi = maxBig, best = [], iter = 0
      while (hi - lo > RES && iter < 20) {
        iter++
        const mid = lo + (hi - lo) / 2n
        const arr = await syncAt(mid)
        if (arr.length) { best = arr; lo = mid } else { hi = mid }
      }
      logs = best
      trace.push('SYNC bsearch iter=' + iter + ' got=' + best.length)
    } catch (e) {
      trace.push('SYNC bsearch ERR ' + (e && e.message ? e.message : e))
    }
  }

  // ③ 폴백: MCHATLOGS
  if (!logs.length) {
    try {
      const r = await send('MCHATLOGS', { chatIds: [cid], sinces: [L.fromNumber(0)] })
      trace.push('MCHATLOGS st=' + (r && r.statusCode))
      if (r && r.statusCode === 0 && r.body && Array.isArray(r.body.chatLogs)) {
        logs = r.body.chatLogs.filter((lg) => toIdString(lg.chatId) === String(chatId))
        trace.push('mchat=' + logs.length)
      }
    } catch (e) {
      trace.push('MCHATLOGS ERR ' + (e && e.message ? e.message : e))
    }
  }

  // 최신순 정렬 후 상위 N (slice 를 sort 뒤에 — 그래야 최신 N 개)
  // ★ v59-A D0: extractItem() 공통 함수로 통일. scope · threadId · attachmentJson 포함.
  const items = logs.map(extractItem)
  items.sort((a, b) => {
    const A = BigInt(a.logId || '0'), B = BigInt(b.logId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  const top = items.slice(0, n)

  // 저자 nick 매핑 — MEMBER 로 저자 셋 한 번에 받아서 닉 채움. 메시지에 "123…" 숫자만
  // 뜨면 누가 누군지 몰라 선택이 힘드니, 바로 여기서 채워준다.
  const authors = Array.from(new Set(top.map((it) => it.authorId).filter(Boolean)))
  if (authors.length) {
    try {
      const r = await send('MEMBER', { chatId: cid, memberIds: authors.map((id) => L.fromString(id)) })
      const arr = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
      const nicks = new Map()
      for (const m of arr) {
        const uid = toIdString(m.userId)
        if (uid) nicks.set(uid, typeof m.nickName === 'string' ? m.nickName : '')
      }
      top.forEach((it) => { it.nick = nicks.get(it.authorId) || '' })
      trace.push('MEMBER(nicks)=' + nicks.size)
    } catch (e) {
      trace.push('MEMBER(nicks) ERR ' + (e && e.message ? e.message : e))
    }
  }

  const newest = top[0] || null
  console.log('[msgs] c=' + chatId
    + ' chatinfoMax=' + (maxLogId ? toIdString(maxLogId) : 'null')
    + ' got=' + top.length
    + ' newestLog=' + (newest ? newest.logId : '-')
    + ' newestAt=' + (newest ? new Date((newest.sendAt || 0) * 1000).toISOString() : '-')
    + ' trace=' + trace.join('|'))

  return { ok: true, count: top.length, chatId: String(chatId), messages: top, trace }
}

// 방의 전체 멤버 목록 — 닉으로 찾아서 바로 신고 플로우로 넘기기 위한 소스.
// 로그인 응답(LOGINLIST) 에 담긴 memberIds 를 MEMBER 로 청크 조회 (한 번에 50명씩).
// pli(오픈프로필 링크 id) 가 있는 멤버는 그 값까지 들고오되, 실제 URL(INFOLINK)은
// 멤버가 선택될 때 memberProfile() 로 따로 받는다 — 전원 INFOLINK 는 너무 비쌈.
export async function members(chatId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const lr = loginResult()
  const chatDatas = (lr && Array.isArray(lr.chatDatas)) ? lr.chatDatas : []
  const room = chatDatas.find((c) => toIdString(c.c) === String(chatId))
  let ids = room && Array.isArray(room.i) ? room.i.map(toIdString).filter(Boolean) : []
  // LOGINLIST 에 멤버 ID 없으면 CHATINFO 로 보충
  if (!ids.length) {
    try {
      const r = await send('CHATINFO', { chatId: cid })
      const ci = r && r.body && r.body.chatInfo
      if (ci) {
        for (const key of ['memberIds', 'displayMemberIds', 'activeMemberIds']) {
          if (Array.isArray(ci[key])) ids = ci[key].map(toIdString).filter(Boolean)
          if (ids.length) break
        }
      }
    } catch (e) {}
  }
  if (!ids.length) return { ok: true, count: 0, members: [], text: '멤버 ID 못 가져옴 (방장이 멤버 공개를 제한했을 수 있음)' }

  const CHUNK = 50
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).map((id) => L.fromString(id))
    try {
      const r = await send('MEMBER', { chatId: cid, memberIds: chunk })
      const arr = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
      for (const m of arr) {
        const pliStr = toIdString(m.pli)
        out.push({
          userId: toIdString(m.userId),
          nick: typeof m.nickName === 'string' ? m.nickName : '',
          ptp: Number(m.ptp) || 0,
          pli: pliStr,
          // `toIdString(null/0)` 이 '0' 을 뱉으므로 "0" 도 명시적으로 제외해야 함 — 안 그러면
          // 일반 프로필 멤버에게도 OpenProfile 칩이 붙고 memberProfile() 조회에서 혼선.
          hasOpenProfile: Number(m.ptp) === 16 && pliStr && pliStr !== '0',
        })
      }
    } catch (e) {
      // 한 청크 실패해도 다음 진행
    }
  }
  // 닉 기준 정렬 (빈 닉은 뒤로)
  out.sort((a, b) => (a.nick || '￿').localeCompare(b.nick || '￿', 'ko'))
  return { ok: true, count: out.length, members: out, text: '멤버 ' + out.length + '명' }
}

// 특정 저자의 과거 메시지만 뽑기 — messages() 결과에서 authorId 필터.
// messages() 가 최대 80 개 창을 반환하니, 그 안에 해당 저자가 있어야 보임.
// 더 올리고 싶으면 messages() cnt 를 80 으로 쓰고 클라이언트에서 필터.
export async function messagesByAuthor(chatId, authorId, cnt) {
  const base = await messages(chatId, cnt || 80)
  if (!base.ok) return base
  const target = String(authorId)
  const filtered = (base.messages || []).filter((m) => String(m.authorId) === target)
  return { ok: true, count: filtered.length, chatId: base.chatId, authorId: target, messages: filtered, trace: base.trace }
}

// 대상 유저가 신고로 "오픈채팅 이용제한" 먹었는지 자동 감지. 처분 떨어지는 순간을 알아야
// 다음 작전(추가 신고 vs 성공 vs 다른 카테고리)을 결정할 수 있다.
//
// 신호 3개를 모아서 LIMITED/ACTIVE/UNKNOWN 로 판정:
//   (a) 오픈프로필 URL HTTP GET  — 이용제한 당하면 "운영정책을 위반한 채팅방" 류 문구나
//                                   비정상 리다이렉트/404 가 뜸
//   (b) LOCO MEMBER 쿼리         — 해당 방에서 그 유저의 상태 (nick/ptp/pli)
//   (c) LOCO CHATINFO 응답       — 방 자체 상태 (링크 블라인드/삭제 여부)
//
// 이용제한 알림 팝업 문구는 docs/BLSPAMS_DEBUG.md 참고:
//   "운영정책을 위반한 채팅방입니다. 이 경우 참여자는 채팅방에 입장할 수 없습니다"
const LIMITED_PATTERNS = [
  /운영정책.*위반/, /운영정책.*위배/, /이용제한/, /입장할 수 없/,
  /차단된/, /사용불가/, /일시 중지/, /정지된/, /블라인드/,
]

async function fetchOpenProfile(url) {
  if (!url) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 7000)
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' })
    const text = await r.text().catch(() => '')
    const matched = LIMITED_PATTERNS.find((re) => re.test(text))
    // 서버 측 리다이렉트/에러 페이지 길이 — 정상 오픈프로필은 수십KB
    return {
      httpCode: r.status,
      finalUrl: r.url,
      bodyLength: text.length,
      limited: !!matched,
      matchedPattern: matched ? matched.toString() : null,
      snippet: text.slice(0, 400),
    }
  } catch (e) {
    return { httpCode: 0, err: String(e && e.message ? e.message : e) }
  } finally { clearTimeout(t) }
}

export async function targetStatus(chatId, userId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId || !userId) return { ok: false, text: 'chatId · userId 필요' }
  const result = { chatId: String(chatId), userId: String(userId), signals: {}, summary: 'UNKNOWN' }

  // (b) + (일부 c): memberProfile 로 MEMBER + INFOLINK 체인
  let profile = null
  try {
    profile = await memberProfile(chatId, userId)
    result.signals.member = {
      found: !!profile && (!!profile.nick || profile.ok !== false),
      nick: profile && profile.nick || '',
      ptp: profile && profile.ptp,
      url: profile && profile.url || null,
      text: profile && profile.text || '',
    }
  } catch (e) {
    result.signals.member = { err: String(e && e.message ? e.message : e) }
  }

  // (a) 오픈프로필 URL fetch — 있을 때만
  if (profile && profile.url) {
    result.signals.openProfile = await fetchOpenProfile(profile.url)
  } else {
    result.signals.openProfile = { skipped: 'URL 없음 (일반 프로필)' }
  }

  // 판정 (정밀도 개선):
  //   LIMITED  — body 패턴 매치일 때만. confident=true
  //   ACTIVE   — 오픈프로필 200 + 멤버 found. confident=true
  //   UNKNOWN  — 404/410 은 삭제일 수도, 일시 오류일 수도 있으므로 LIMITED 로 단정하지 않음
  const op = result.signals.openProfile || {}
  const mem = result.signals.member || {}
  let confident = false
  if (op.limited) {
    result.summary = 'LIMITED'
    result.text = '★ 이용제한 감지 (body 패턴): ' + (op.matchedPattern || '(패턴)')
    confident = true
  } else if (op.httpCode === 200 && mem.found) {
    result.summary = 'ACTIVE'
    result.text = '멀쩡함 — 처분 아직 (nick=' + (mem.nick || '-') + ', url 접근 OK)'
    confident = true
  } else if (op.httpCode === 404 || op.httpCode === 410) {
    result.summary = 'UNKNOWN'
    result.text = '오픈프로필 ' + op.httpCode + ' — 삭제/비활성 또는 일시 오류 (단정 불가)'
  } else {
    result.summary = 'UNKNOWN'
    result.text = '판정 불가 — member=' + JSON.stringify(mem).slice(0, 80) + ' · openProfile=' + JSON.stringify(op).slice(0, 80)
  }
  result.confident = confident
  result.ok = true
  return result
}

// CHATINFO 로 방 멤버 포함 상세. 열린 방의 공식 멤버 목록도 여기서.
export async function roomInfo(chatId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const L = await longOf()
  try {
    const r = await send('CHATINFO', { chatId: L.fromString(String(chatId)) })
    return { ok: r && r.statusCode === 0, statusCode: r && r.statusCode, body: r && r.body }
  } catch (e) {
    return { ok: false, text: 'CHATINFO 실패: ' + (e && e.message ? e.message : e) }
  }
}

// 방의 멤버 한 명의 오픈프로필 링크. MEMBER 로 pli 받고 INFOLINK 로 lu 받는다.
// ptp == 16 (오픈프로필) 인 멤버만 pli 를 갖는다. 그렇지 않으면 링크 없음.
export async function memberProfile(chatId, userId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId || !userId) return { ok: false, text: 'chatId · userId 필요' }
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const uid = L.fromString(String(userId))
  const trace = []

  let member = null
  try {
    const r = await send('MEMBER', { chatId: cid, memberIds: [uid] })
    trace.push('MEMBER st=' + (r && r.statusCode))
    const members = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
    member = members.find((m) => toIdString(m.userId) === String(userId)) || members[0] || null
  } catch (e) {
    trace.push('MEMBER ERR ' + (e && e.message ? e.message : e))
    return { ok: false, trace, text: trace.join(' · ') }
  }
  if (!member) return { ok: false, trace, text: '멤버 못 찾음 · ' + trace.join(' · ') }

  const nick = typeof member.nickName === 'string' ? member.nickName : ''
  const ptp = Number(member.ptp)
  const pliStr = toIdString(member.pli)
  trace.push('ptp=' + ptp + ' pli=' + (pliStr || '-'))

  if (!pliStr || pliStr === '0') {
    return { ok: true, nick, ptp, url: null, trace, text: '오픈프로필 없음(일반 프로필)' }
  }

  try {
    const r = await send('INFOLINK', { lis: [L.fromString(pliStr)] })
    trace.push('INFOLINK st=' + (r && r.statusCode))
    const ols = r && r.body && Array.isArray(r.body.ols) ? r.body.ols : []
    const ol = ols[0]
    const url = ol && typeof ol.lu === 'string' ? ol.lu : null
    const linkName = ol && typeof ol.ln === 'string' ? ol.ln : ''
    return { ok: true, nick, ptp, url, linkName, trace }
  } catch (e) {
    trace.push('INFOLINK ERR ' + (e && e.message ? e.message : e))
    return { ok: false, nick, ptp, trace, text: trace.join(' · ') }
  }
}
