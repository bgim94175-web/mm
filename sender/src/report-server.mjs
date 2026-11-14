// 독립 서버 — 봇 없이 돈다. node src/report-server.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import * as AUTH from './report-auth.mjs'
import * as RH from './report-http.mjs'

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

  if (p === '/report/me') return send(res, 200, AUTH.me())
  if (p === '/report/status') return send(res, 200, RH.status())

  if (p === '/report/login' && req.method === 'POST') {
    const b = await readBody(req)
    const r = await AUTH.login(String(b.email || ''), String(b.password || ''), b.deviceType === 'pc' ? 'pc' : 'tablet')
    return send(res, 200, r)
  }
  if (p === '/report/passcode' && req.method === 'POST') {
    const b = await readBody(req)
    return send(res, 200, await AUTH.passcode(String(b.code || '')))
  }
  if (p === '/report/logout' && req.method === 'POST') {
    AUTH.clear()
    return send(res, 200, { ok: true })
  }

  if (p === '/report/host' || p === '/report/slugs' || p === '/report/fire') {
    const uid = String(u.searchParams.get('uid') || '')
    if (!uid) return send(res, 400, { ok: false, error: 'uid' })
    const text = String(u.searchParams.get('text') || '')
    const next = chain.then(() => {
      if (p === '/report/host') return RH.probeHost(uid)
      if (p === '/report/slugs') return RH.probeSlugs(uid)
      return RH.fire(uid, text)
    })
    chain = next.catch(() => {})
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