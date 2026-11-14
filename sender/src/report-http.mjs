// 프로필 신고 HTTP GET /talk/profile25/report/{slug}
import { get as getCred } from './report-auth.mjs'

export const HOSTS = ['https://talk.kakao.com', 'https://katalk.kakao.com', 'https://dn-m.talk.kakao.com']
export const SLUGS = [
  'spam', 'sexual', 'protect_child', 'violent', 'illegal', 'privacy',
  'etc', 'suicide', 'fraud', 'right_infringement', 'illegal_filming', 'youth_unsuitable',
]
const GAP = 1500
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const L = (s) => console.log(s)

function headersOf() {
  const c = getCred()
  if (!c || !c.oauthToken) throw new Error('로그인 안 됨')
  return {
    authorization: `${c.oauthToken}-${c.duuid}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

async function hit(host, slug, body) {
  const r = await fetch(`${host}/talk/profile25/report/${slug}`, {
    method: 'GET', headers: headersOf(), body: JSON.stringify(body),
  })
  let j = null
  try { j = await r.json() } catch {}
  return { code: r.status, st: j && j.status, url: j && j.url }
}

async function pickHost(userId) {
  const body = { userId: String(userId), referer: 1, meta: {}, attachments: [] }
  for (const h of HOSTS) {
    const r = await hit(h, 'etc', body)
    L(`report host ${h} → ${r.code}`)
    await sleep(GAP)
    if (r.code !== 404) return { host: h, first: r }
  }
  throw new Error('host 미확정')
}

export function status() {
  const c = getCred()
  return {
    ok: true,
    cred: c && c.oauthToken ? 'O' : 'X',
    slugs: SLUGS.length,
    hosts: HOSTS,
    text: `cred ${c && c.oauthToken ? 'O' : 'X'} · 슬러그 ${SLUGS.length}개`,
  }
}

export async function probeHost(userId) {
  const p = await pickHost(userId)
  return { ok: p.first.code === 200, code: p.first.code, host: p.host, text: `${p.host} → ${p.first.code} / status ${p.first.st}` }
}

export async function probeSlugs(userId) {
  const p = await pickHost(userId)
  const rows = []
  for (const slug of SLUGS) {
    const r = await hit(p.host, slug, { userId: String(userId), referer: 1, meta: {}, attachments: [] })
    rows.push(`${slug}:${r.code}`)
    L(`report slug ${slug} → ${r.code}`)
    await sleep(GAP)
  }
  const ok = rows.filter((x) => x.endsWith(':200')).length
  return { ok: ok > 0, count: ok, rows, text: `접수 ${ok}/${SLUGS.length}\n${rows.join(' · ')}` }
}

export async function fire(userId, content) {
  const p = await pickHost(userId)
  const rows = []
  for (const slug of SLUGS) {
    const body = {
      userId: String(userId), referer: 1,
      meta: { content: content || '아 ㅅㅂ 존나 짜증나네', contentTimestamp: String(Date.now()) },
      attachments: [],
    }
    const r = await hit(p.host, slug, body)
    rows.push(`${slug}:${r.code}`)
    L(`report fire ${slug} uid ${userId} → ${r.code}`)
    await sleep(GAP)
  }
  const ok = rows.filter((x) => x.endsWith(':200')).length
  return { ok: ok > 0, count: ok, rows, text: `접수 ${ok}/${SLUGS.length}\n${rows.join(' · ')}` }
}