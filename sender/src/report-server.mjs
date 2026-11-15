// 독립 서버 — 봇 없이 돈다. node src/report-server.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import * as AUTH from './report-auth.mjs'
import * as RH from './report-http.mjs'
import * as LOCO from './report-loco.mjs'
import * as MSG from './report-msg.mjs'
import * as BROWSE from './report-browse.mjs'
import * as OPEN from './report-openchat.mjs'
import * as ACC from './report-accounts.mjs'
import * as DB from './report-db.mjs'

const PORT = Number(process.env.PORT || 8080)
const PUB = join(process.cwd(), 'public', 'report')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))
process.on('uncaughtException', (e) => console.error('uncaughtException', e))

let chain = Promise.resolve()

function keyOf() {
  return process.env.SENDER_REPORT_API_KEY || ''
}

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let b = ''
    let done = false
    const finish = function (v) { if (!done) { done = true; resolve(v) } }
    req.on('data', function (c) {
      b += c
      if (b.length > 1e6) { req.destroy(); finish({}) }
    })
    req.on('end', function () {
      try { finish(JSON.parse(b || '{}')) } catch (e) { finish({}) }
    })
    req.on('aborted', function () { finish({}) })
    req.on('error', function () { finish({}) })
  })
}

async function staticFile(res, name) {
  try {
    const buf = await readFile(join(PUB, name))
    send(res, 200, buf, MIME[extname(name)] || 'application/octet-stream')
  } catch (e) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8')
  }
}

function queue(fn) {
  const next = chain.then(fn)
  chain = next.catch(function () {})
  return next
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  const k = u.searchParams.get('k') || req.headers['x-api-key'] || ''

  if (p === '/' || p === '/report' || p === '/report/') return staticFile(res, 'index.html')
  if (p === '/report/manifest.json') return staticFile(res, 'manifest.json')
  if (p === '/report/icon.svg') return staticFile(res, 'icon.svg')
  if (p === '/report/sw.js') return staticFile(res, 'sw.js')
  if (p === '/report/health') return send(res, 200, { ok: true })

  if (!p.startsWith('/report/')) return send(res, 404, { ok: false })
  if (keyOf() && k !== keyOf()) return send(res, 401, { ok: false, error: 'key' })

  if (p === '/report/me') {
    const m = AUTH.me()
    m.loco = LOCO.ready() ? 'O' : 'X'
    if (!LOCO.ready() && LOCO.error()) m.locoError = LOCO.error()
    m.dbBackend = DB.status().backend
    return send(res, 200, m)
  }
  if (p === '/report/status') {
    const s = RH.status()
    s.loco = LOCO.ready() ? 'O' : 'X'
    if (!LOCO.ready() && LOCO.error()) s.locoError = LOCO.error()
    return send(res, 200, s)
  }

  if (p === '/report/loco-reconnect' && req.method === 'POST') {
    const b = await readBody(req)
    try {
      await LOCO.connect(b.deviceType)
      return send(res, 200, { ok: true, loco: 'O' })
    } catch (e) {
      return send(res, 200, { ok: false, message: String(e && e.message ? e.message : e) })
    }
  }

  if (p === '/report/login' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await AUTH.login(String(b.email || ''), String(b.password || ''), b.deviceType === 'pc' ? 'pc' : 'tablet')
    if (r.ok) {
      try {
        await LOCO.connect(b.deviceType)
        r.loco = 'O'
      } catch (e) {
        r.loco = 'X'
        r.locoError = String(e && e.message ? e.message : e)
        console.log('loco 실패: ' + r.locoError)
      }
    }
    return send(res, 200, r)
  }
  if (p === '/report/passcode' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await AUTH.passcode(String(b.code || ''))
    if (r.ok) {
      try {
        await LOCO.connect(b.deviceType)
        r.loco = 'O'
      } catch (e) {
        r.loco = 'X'
        r.locoError = String(e && e.message ? e.message : e)
        console.log('loco 재연결 실패: ' + r.locoError)
      }
    }
    return send(res, 200, r)
  }
  if (p === '/report/logout' && req.method === 'POST') {
    await AUTH.clear()
    LOCO.close()
    return send(res, 200, { ok: true })
  }

  // 메시지 신고 전에 LOCO 가 끊어져 있으면 한 번 재연결 시도
  if ((p === '/report/msg' || p === '/report/msgfire') && !LOCO.ready()) {
    try { await LOCO.connect() }
    catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
  }

  if (p === '/report/host' || p === '/report/slugs' || p === '/report/fire') {
    const uid = String(u.searchParams.get('uid') || '')
    if (!uid) return send(res, 400, { ok: false, error: 'uid' })
    const text = String(u.searchParams.get('text') || '')
    const next = queue(function () {
      if (p === '/report/host') return RH.probeHost(uid)
      if (p === '/report/slugs') return RH.probeSlugs(uid)
      return RH.fire(uid, text)
    })
    return send(res, 200, await next)
  }

  if (p === '/report/msg' || p === '/report/msgfire') {
    const c = String(u.searchParams.get('c') || '')
    const l = String(u.searchParams.get('l') || '')
    const t = String(u.searchParams.get('uid') || '')
    const text = String(u.searchParams.get('text') || '')
    const method = String(u.searchParams.get('method') || '')
    if (!c || !l || !t) return send(res, 400, { ok: false, error: 'c/l/uid' })
    const next = queue(function () {
      if (p === '/report/msg') return MSG.probe(c, l, t)
      const ids = l.split(',').map(function (x) { return x.trim() }).filter(Boolean)
      return MSG.fire(c, ids, t, text, method)
    })
    return send(res, 200, await next)
  }

  // 운영자 전용 raw LOCO. POST {method, body}. body 안의 __long:["chatId","logId"] 로 Long 감싸기.
  if (p === '/report/raw' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return MSG.raw(String(b.method || ''), b.body || {}) })
    return send(res, 200, r)
  }

  // BLSPAMS 바디 변형 탐색 — context 전부 받아서 여러 조합으로 쏜다
  if (p === '/report/msg-shape' && req.method === 'POST') {
    const b = await readBody(req)
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return MSG.probeShape(b) })
    return send(res, 200, r)
  }

  // BLSPAMS 바디 BSON hex 덤프 — frida 캡처와 비교
  if (p === '/report/msg-dump' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await MSG.dumpBytes(b)
    return send(res, 200, r)
  }

  // 오픈채팅 HTTP 신고 — POST c/fraud/report/chatLogs 경로 탐색 + 발사
  if (p === '/report/openchat-hosts' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.probeHosts(b) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-shapes' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.probeShapes(String(b.host || ''), b.ctx || b) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-fire' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.fire(String(b.host || ''), b.ctx || b, b.reasons) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-fireAll' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.fireAll(b.ctx || b) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-one' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.reportOne(b.ctx || b, String(b.category || 'SPAM')) })
    return send(res, 200, r)
  }
  // 다계정 fanout — body { ctx, category, userIds?, gapMs? }
  if (p === '/report/openchat-fanout' && req.method === 'POST') {
    const b = await readBody(req)
    const userIds = Array.isArray(b.userIds) ? b.userIds.map(String) : []
    const gapMs = Number(b.gapMs) > 0 ? Number(b.gapMs) : 500
    const r = await queue(function () { return OPEN.fanout(b.ctx || b, String(b.category || 'VIOLENT'), userIds, { gapMs }) })
    return send(res, 200, r)
  }

  // ─── 다계정 관리 ───
  if (p === '/report/accounts/list') {
    const r = await ACC.list()
    return send(res, 200, { ok: true, accounts: r })
  }
  if (p === '/report/accounts/add' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await ACC.addLogin(String(b.email || ''), String(b.password || ''), b.deviceType === 'pc' ? 'pc' : 'tablet')
    return send(res, 200, r)
  }
  if (p === '/report/accounts/add-passcode' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await ACC.addPasscode(String(b.code || ''))
    return send(res, 200, r)
  }
  if (p === '/report/accounts/remove' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.userId) return send(res, 400, { ok: false, error: 'userId' })
    const r = await ACC.remove(String(b.userId))
    return send(res, 200, r)
  }
  if (p === '/report/accounts/toggle' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.userId) return send(res, 400, { ok: false, error: 'userId' })
    const r = await ACC.setActive(String(b.userId), !!b.active)
    return send(res, 200, r)
  }

  // 둘러보기 — 봇이 로그인한 방 목록
  if (p === '/report/rooms') {
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    return send(res, 200, BROWSE.rooms())
  }

  // 방 하나의 최근 메시지
  if (p === '/report/room-msgs') {
    const c = String(u.searchParams.get('c') || '')
    const cnt = Number(u.searchParams.get('cnt') || '15')
    if (!c) return send(res, 400, { ok: false, error: 'c' })
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return BROWSE.messages(c, cnt) })
    return send(res, 200, r)
  }

  // 방의 전체 멤버 목록 — 닉 검색용
  if (p === '/report/room-members') {
    const c = String(u.searchParams.get('c') || '')
    if (!c) return send(res, 400, { ok: false, error: 'c' })
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return BROWSE.members(c) })
    return send(res, 200, r)
  }

  // 방 안에서 특정 저자의 메시지만
  if (p === '/report/author-msgs') {
    const c = String(u.searchParams.get('c') || '')
    const uid = String(u.searchParams.get('uid') || '')
    const cnt = Number(u.searchParams.get('cnt') || '80')
    if (!c || !uid) return send(res, 400, { ok: false, error: 'c/uid' })
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return BROWSE.messagesByAuthor(c, uid, cnt) })
    return send(res, 200, r)
  }

  // 대상 유저의 이용제한 감지 — 오픈프로필 fetch + MEMBER 상태 체인
  if (p === '/report/target-status') {
    const c = String(u.searchParams.get('c') || '')
    const uid = String(u.searchParams.get('uid') || '')
    if (!c || !uid) return send(res, 400, { ok: false, error: 'c/uid' })
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return BROWSE.targetStatus(c, uid) })
    return send(res, 200, r)
  }

  // 멤버 한 명의 오픈프로필 링크 (MEMBER → pli → INFOLINK → lu)
  if (p === '/report/member-link') {
    const c = String(u.searchParams.get('c') || '')
    const uid = String(u.searchParams.get('uid') || '')
    if (!c || !uid) return send(res, 400, { ok: false, error: 'c/uid' })
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return BROWSE.memberProfile(c, uid) })
    return send(res, 200, r)
  }

  send(res, 404, { ok: false })
}

const server = createServer(function (req, res) {
  handle(req, res).catch(function (e) {
    send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  })
})

async function bootAndListen() {
  try { await DB.init() } catch (e) { console.log('[db] init 실패: ' + (e && e.message)) }
  try {
    const prev = await AUTH.preload()
    if (prev && prev.oauthToken) {
      console.log('[auth] 저장된 토큰 로드됨 uid=' + (prev.userId || '-'))
      try { await LOCO.connect() ; console.log('[loco] 자동 재연결 OK') }
      catch (e) { console.log('[loco] 자동 재연결 실패(계정 유효성 확인 필요): ' + (e && e.message)) }
    } else {
      console.log('[auth] 저장된 토큰 없음 — 웹에서 로그인 필요')
    }
  } catch (e) { console.log('[boot] preload 실패: ' + (e && e.message)) }
  server.listen(PORT, function () {
    console.log('report console on :' + PORT + ' / backend=' + DB.status().backend)
  })
}
bootAndListen()
