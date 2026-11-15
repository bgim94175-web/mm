// 독립 서버 — 봇 없이 돈다. node src/report-server.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import * as AUTH from './report-auth.mjs'
import * as RH from './report-http.mjs'
import * as LOCO from './report-loco.mjs'
import * as POOL from './report-loco-pool.mjs'
import * as MSG from './report-msg.mjs'
import * as BROWSE from './report-browse.mjs'
import * as OPEN from './report-openchat.mjs'
import * as ACC from './report-accounts.mjs'
import * as WATCH from './report-watch.mjs'
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
      await DB.clearLocoFail().catch(() => {})
      return send(res, 200, { ok: true, loco: 'O' })
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      await DB.recordLocoFail(msg).catch(() => {})
      return send(res, 200, { ok: false, message: msg })
    }
  }
  // LOCO 쿨다운 상태 조회 — UI 안내용
  if (p === '/report/loco-state') {
    const s = await DB.loadLocoState().catch(() => null)
    const cooldownMin = Math.max(5, Number(process.env.LOCO_RETRY_COOLDOWN_MIN) || 60)
    const since = s && s.lastFailAt ? Math.floor((Date.now() - s.lastFailAt) / 60000) : null
    const inCooldown = since != null && since < cooldownMin
    return send(res, 200, { ok: true, cooldownMin, since, inCooldown, lastErr: s ? s.lastErr : '' })
  }
  // 다계정 LOCO 풀 상태 — UI 상 각 fanout 계정의 세션 유무·쿨다운 표시
  if (p === '/report/loco-pool/status') {
    const r = await POOL.status().catch((e) => ({ error: String(e && e.message ? e.message : e) }))
    return send(res, 200, Object.assign({ ok: true }, r))
  }
  if (p === '/report/loco-pool/close' && req.method === 'POST') {
    const b = await readBody(req)
    if (b && b.userId) { await POOL.closeSlot(String(b.userId)).catch(() => {}) }
    else { POOL.closeAll() }
    return send(res, 200, { ok: true })
  }
  if (p === '/report/loco-pool/reset-cooldown' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b || !b.userId) return send(res, 400, { ok: false, error: 'userId' })
    const r = await POOL.resetCooldown(String(b.userId))
    return send(res, 200, r)
  }
  if (p === '/report/loco-pool/ensure' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b || !b.userId) return send(res, 400, { ok: false, error: 'userId' })
    try {
      await POOL.ensureSlot(String(b.userId))
      return send(res, 200, { ok: true, userId: String(b.userId) })
    } catch (e) {
      return send(res, 200, { ok: false, userId: String(b.userId), error: String(e && e.message ? e.message : e) })
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

  if (p === '/report/raw' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return MSG.raw(String(b.method || ''), b.body || {}) })
    return send(res, 200, r)
  }

  if (p === '/report/msg-shape' && req.method === 'POST') {
    const b = await readBody(req)
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    const r = await queue(function () { return MSG.probeShape(b) })
    return send(res, 200, r)
  }

  if (p === '/report/msg-dump' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await MSG.dumpBytes(b)
    return send(res, 200, r)
  }

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
    const r = await queue(function () { return OPEN.reportOne(b.ctx || b, String(b.category || 'spam')) })
    return send(res, 200, r)
  }
  // "차단하고 신고하기" — Report POST + KICKMEM LOCO 체인
  if (p === '/report/openchat-report-block' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.reportAndBlock(b.ctx || b, String(b.category || 'violent')) })
    return send(res, 200, r)
  }
  // 프로필(=openlink 자체) 신고 — /c/fraud/report/link. chatId/userId 안 쓰고 linkId 만 필요.
  // 라이브 로그가 보여준 "chatLogs silent-accept" 를 우회할 결정적 후보 (APK 5차 확정).
  if (p === '/report/openchat-report-link' && req.method === 'POST') {
    const b = await readBody(req)
    const linkId = String(b.linkId || (b.ctx && b.ctx.linkId) || '')
    if (!linkId) return send(res, 400, { ok: false, text: 'linkId 필요' })
    const r = await queue(function () { return OPEN.reportLink(linkId, String(b.category || 'violent')) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-report-link-block' && req.method === 'POST') {
    const b = await readBody(req)
    const linkId = String(b.linkId || (b.ctx && b.ctx.linkId) || '')
    const chatId = String(b.chatId || (b.ctx && b.ctx.chatId) || '')
    const targetUserId = String(b.targetUserId || (b.ctx && b.ctx.authorId) || '')
    if (!linkId) return send(res, 400, { ok: false, text: 'linkId 필요' })
    const r = await queue(function () { return OPEN.reportLinkAndBlock({ linkId, chatId, targetUserId }, String(b.category || 'violent')) })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-fanout-link' && req.method === 'POST') {
    const b = await readBody(req)
    const linkId = String(b.linkId || (b.ctx && b.ctx.linkId) || '')
    const chatId = String(b.chatId || (b.ctx && b.ctx.chatId) || '')
    const targetUserId = String(b.targetUserId || (b.ctx && b.ctx.authorId) || '')
    if (!linkId) return send(res, 400, { ok: false, text: 'linkId 필요' })
    const userIds = Array.isArray(b.userIds) ? b.userIds.map(String) : []
    const gapMs = Number(b.gapMs) >= 0 ? Number(b.gapMs) : 2500
    const jitterMs = Number(b.jitterMs) >= 0 ? Number(b.jitterMs) : 1500
    const shuffle = b.shuffle !== false
    const postBlock = !!b.postBlock
    const r = await queue(function () {
      return OPEN.fanoutLink({ linkId, chatId, targetUserId }, String(b.category || 'violent'), userIds, { gapMs, jitterMs, shuffle, postBlock })
    })
    return send(res, 200, r)
  }
  if (p === '/report/openchat-dump' && req.method === 'POST') {
    // 실제 발사 X — 봇이 보낼 바이트 전체를 frida 포맷으로 돌려줌. 앱 캡쳐와 바이트 단위 diff 용.
    const b = await readBody(req)
    try {
      const r = OPEN.dumpRequest(b.ctx || b, String(b.category || 'violent'))
      return send(res, 200, r)
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e && e.message ? e.message : e) })
    }
  }
  if (p === '/report/openchat-fanout' && req.method === 'POST') {
    const b = await readBody(req)
    const userIds = Array.isArray(b.userIds) ? b.userIds.map(String) : []
    const gapMs = Number(b.gapMs) >= 0 ? Number(b.gapMs) : 2500
    const jitterMs = Number(b.jitterMs) >= 0 ? Number(b.jitterMs) : 1500
    const shuffle = b.shuffle !== false
    const postBlock = !!b.postBlock
    const r = await queue(function () {
      return OPEN.fanout(b.ctx || b, String(b.category || 'violent'), userIds, { gapMs, jitterMs, shuffle, postBlock })
    })
    return send(res, 200, r)
  }

  // ★ 신규: 진단 엔드포인트
  if (p === '/report/openchat-diagnose' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await queue(function () { return OPEN.diagnoseContentMatch(b.ctx || b, b.opts || {}) })
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
  if (p === '/report/accounts/promote' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.userId) return send(res, 400, { ok: false, error: 'userId' })
    const r = await ACC.promoteToPrimary(String(b.userId))
    return send(res, 200, r)
  }

  if (p === '/report/rooms') {
    if (!LOCO.ready()) {
      try { await LOCO.connect() }
      catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message ? e.message : e) }) }
    }
    // LCHATLIST 폴백은 bsearch 네트워크라 queue 안쪽에서
    const r = await queue(function () { return BROWSE.rooms() })
    return send(res, 200, r)
  }
  // chatId 로 방 하나만 CHATINFO 조회 (LOGINLIST partial snapshot 폴백)
  if (p === '/report/room-lookup') {
    const c = String(u.searchParams.get('c') || '')
    if (!c) return send(res, 400, { ok: false, text: 'c (chatId) 필요' })
    const r = await queue(function () { return BROWSE.lookupRoomByChatId(c) })
    return send(res, 200, r)
  }

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

  if (p === '/report/watch/list') {
    return send(res, 200, { ok: true, items: WATCH.list(), intervalMs: 30000 })
  }
  if (p === '/report/watch/status') {
    const c = String(u.searchParams.get('c') || ''); const uid = String(u.searchParams.get('uid') || '')
    if (!c || !uid) return send(res, 400, { ok: false, error: 'c/uid' })
    return send(res, 200, Object.assign({ ok: true }, WATCH.status(c, uid)))
  }
  if (p === '/report/watch/add' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.chatId || !b.userId) return send(res, 400, { ok: false, error: 'chatId/userId' })
    if (!LOCO.ready()) { try { await LOCO.connect() } catch (e) { return send(res, 200, { ok: false, text: 'LOCO 연결 실패: ' + (e && e.message) }) } }
    // watch.autoFire 는 linkId 만 있으면 작동. injectText 는 enableInject=true 로 명시해야 사용.
    const autoFire = b.autoFire && b.autoFire.linkId ? {
      linkId: String(b.autoFire.linkId),
      category: String(b.autoFire.category || 'violent'),
      gapMs: Number(b.autoFire.gapMs) >= 0 ? Number(b.autoFire.gapMs) : 2500,
      jitterMs: Number(b.autoFire.jitterMs) >= 0 ? Number(b.autoFire.jitterMs) : 1500,
      enableInject: b.autoFire.enableInject === true,
      injectText: b.autoFire.injectText ? String(b.autoFire.injectText) : '',
    } : null
    return send(res, 200, WATCH.add(String(b.chatId), String(b.userId), { autoFire }))
  }
  if (p === '/report/watch/remove' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.chatId || !b.userId) return send(res, 400, { ok: false, error: 'chatId/userId' })
    return send(res, 200, WATCH.remove(String(b.chatId), String(b.userId)))
  }
  if (p === '/report/watch/clear' && req.method === 'POST') {
    return send(res, 200, WATCH.removeAll())
  }

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
      // Render Free tier 는 15분 비활동 시 instance sleep → 요청마다 cold-start.
      // 매번 LOCO.connect() 돌리면 LOGINLIST 가 반복 발사되어 서버가 anti-abuse 걸림(-328).
      // DB 에 저장된 "최근 실패 시각" 이 쿨다운 안이면 자동 접속 skip (수동 재연결은 쿨다운 무시).
      const cooldownMin = Math.max(5, Number(process.env.LOCO_RETRY_COOLDOWN_MIN) || 60)
      const state = await DB.loadLocoState().catch(() => null)
      const since = state && state.lastFailAt ? Math.floor((Date.now() - state.lastFailAt) / 60000) : Infinity
      if (state && since < cooldownMin) {
        console.log('[loco] 자동 재연결 skip — ' + since + '분 전 실패 (쿨다운 ' + cooldownMin + '분). 사유: ' + (state.lastErr || '-'))
      } else {
        try {
          await LOCO.connect()
          await DB.clearLocoFail().catch(() => {})
          console.log('[loco] 자동 재연결 OK')
        } catch (e) {
          const msg = String(e && e.message ? e.message : e)
          await DB.recordLocoFail(msg).catch(() => {})
          console.log('[loco] 자동 재연결 실패(계정 유효성 확인 필요, ' + cooldownMin + '분 쿨다운 기록됨): ' + msg)
        }
      }
    } else {
      console.log('[auth] 저장된 토큰 없음 — 웹에서 로그인 필요')
    }
  } catch (e) { console.log('[boot] preload 실패: ' + (e && e.message)) }
  // 다계정 LOCO 풀 — idle 30분 넘은 세션 자동 close
  try { POOL.startIdleSweep() } catch (e) {}
  server.listen(PORT, function () {
    console.log('report console on :' + PORT + ' / backend=' + DB.status().backend)
  })
}
bootAndListen()
