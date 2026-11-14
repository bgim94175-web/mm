// 메시지 신고 — BLSPAMS 는 K bot 본체·agent-messenger 어디에도 없는 추정 메서드.
// 지금은 몇 가지 후보 이름을 동시에 때려서 어느 메서드가 -300(없는 명령) 이 아닌지 가려낸다.
// 바디도 추정이라, 실측 로그 받기 전까지는 답 상태코드 + body 전체를 그대로 돌려본다.
import { send, ready } from './report-loco.mjs'

// -300=없는 명령, -203=본문틀림, 0=성공, 그 외=서버 자체 코드
const REASONS = [0, 1, 2, 3, 4, 5]
// 후보 메서드명 — 실측 전까지는 못 확정. 사용자가 한 번 돌리고 어느 게 -300 안 뜨는지 알려 주면 그걸로 좁힌다.
const CANDIDATE_METHODS = ['BLSPAMS', 'LBLSPAMS', 'OREPORT', 'OCREPORT', 'REPORT', 'CHATREPORT', 'SPAMMSG']
const TEXT = {
  0: '아 씨발 좆같네 진짜 지랄하네',
  1: '텔레그램 오픈톡 홍보합니다 쪽지주세요 링크 확인',
  2: '야동 링크 올립니다 성인영상 필요하신분 쪽지',
  3: '리딩방 수익인증 합니다 원금보장 고수익 보장',
  4: '초등학생도 들어오는 방인데 성인광고 올리네요',
  5: '불법 프로그램 배포합니다 크랙 토렌트 링크',
}
const GAP = 1500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function longOf() {
  try { return (await import('bson')).Long } catch (e) {}
  throw new Error('Long 없음 — npm install bson')
}

function fmtResp(r) {
  if (!r) return { st: 'NULL' }
  const b = r.body || {}
  const keys = Object.keys(b)
  return { st: r.statusCode, bodyKeys: keys, body: keys.length ? b : null }
}

function errRow(e) {
  const s = String(e && e.message ? e.message : e)
  if (/timeout/i.test(s)) return { st: 'TIMEOUT' }
  if (/연결/i.test(s)) return { st: 'LOCO_DEAD', err: s.slice(0, 80) }
  return { st: 'ERR', err: s.slice(0, 120) }
}

async function callOne(method, L, chatId, logIds, targetIds, datas, types, sr) {
  const body = {
    st: 3,
    c: L.fromString(String(chatId)),
    ls: logIds.map((x) => L.fromString(String(x))),
    ss: targetIds.map((x) => L.fromString(String(x))),
    lds: datas,
    lts: types,
    sr,
    bi: false,
  }
  try {
    const r = await send(method, body)
    return fmtResp(r)
  } catch (e) {
    return errRow(e)
  }
}

// 후보 메서드 다 때려본다. -300(없는 명령) 이 아닌 답 하나라도 있으면 그 메서드가 산다.
// st=0 이면 성공. 그 외는 바디·상태코드 전부 돌려서 사용자가 보고 판단.
export async function probe(chatId, logId, targetId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음 — 로그인부터' }
  const L = await longOf()
  const rows = []
  for (const method of CANDIDATE_METHODS) {
    const r = await callOne(method, L, chatId, [logId], [targetId], [TEXT[0]], [1], 0)
    const tag = method + ':' + r.st + (r.bodyKeys && r.bodyKeys.length ? '(' + r.bodyKeys.join(',') + ')' : '')
    rows.push(tag)
    console.log('report probe ' + method + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
    if (r.st === 0) {
      return { ok: true, method, rows, text: '성공 메서드=' + method + '\n' + rows.join(' · '), lastBody: r.body }
    }
  }
  // 하나도 성공 못 하면 -300 아닌 것(=메서드는 있다)만 추려 보여준다
  const alive = rows.filter((x) => !x.includes(':-300') && !x.includes(':ERR'))
  const hint = alive.length
    ? '살아있는 메서드: ' + alive.join(' · ') + ' (바디 조정 필요)'
    : '모든 후보 메서드 서버가 거부 — 다른 메서드명 필요'
  return { ok: false, rows, text: '전부 실패\n' + rows.join(' · ') + '\n→ ' + hint }
}

// 메시지 발사 — 확정된 메서드 하나로 sr0~5 전체 쏘기. (method 인자 안 주면 BLSPAMS 기본)
export async function fire(chatId, logIds, targetId, text, method) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음 — 로그인부터' }
  const m = String(method || 'BLSPAMS')
  const L = await longOf()
  const rows = []
  for (const sr of REASONS) {
    const datas = text ? logIds.map(() => text) : logIds.map(() => TEXT[sr])
    const types = logIds.map(() => 1)
    const r = await callOne(m, L, chatId, logIds, logIds.map(() => targetId), datas, types, sr)
    rows.push('sr' + sr + 'x' + logIds.length + ':' + r.st)
    console.log('report fire ' + m + ' sr=' + sr + ' n=' + logIds.length + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
  }
  const ok = rows.filter((x) => x.endsWith(':0')).length
  return { ok: ok > 0, method: m, count: ok, rows, text: '접수 ' + ok + '/' + rows.length + ' (method=' + m + ')\n' + rows.join(' · ') }
}

// 운영자가 직접 임의 LOCO 메서드·바디를 때려 보는 raw 엔드포인트. {method, body} 받아서 서버 응답을 그대로.
// body 안에 __long: [{field: value}] 식으로 넣으면 그 필드만 Long 으로 감싼다.
export async function raw(method, body) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!method) return { ok: false, text: 'method 필요' }
  const L = await longOf()
  const b = { ...(body || {}) }
  const longFields = Array.isArray(b.__long) ? b.__long : []
  delete b.__long
  for (const f of longFields) {
    if (b[f] != null) {
      try { b[f] = L.fromString(String(b[f])) } catch (e) {}
    }
  }
  try {
    const r = await send(method, b)
    return { ok: r && r.statusCode === 0, statusCode: r ? r.statusCode : null, body: r && r.body ? r.body : null }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}
