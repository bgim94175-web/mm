// 독립 서버 — 봇 없이 돈다. node src/report-server.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import * as AUTH from './report-auth.mjs'
import * as RH from './report-http.mjs'
import * as LOCO from './report-loco.mjs'
import * as MSG from './report-msg.mjs'

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
    req.on('data', function (c) {
      b += c
      if (b.length > 1e6) req.destroy()
    })
    req.on('end', function () {
      try { resolve(JSON.parse(b || '{}')) } catch (e) { resolve({}) }
    })
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
    AUTH.clear()
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
    if (!c || !l || !t) return send(res, 400, { ok: false, error: 'c/l/uid' })
    const next = queue(function () {
      if (p === '/report/msg') return MSG.probe(c, l, t)
      const ids = l.split(',').map(function (x) { return x.trim() }).filter(Boolean)
      return MSG.fire(c, ids, t, text)
    })
    return send(res, 200, await next)
  }

  send(res, 404, { ok: false })
}

const server = createServer(function (req, res) {
  handle(req, res).catch(function (e) {
    send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  })
})

server.listen(PORT, function () {
  console.log('report console on :' + PORT)
})
