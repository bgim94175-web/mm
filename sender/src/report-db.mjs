// LOCO 로그인 자격 (oauthToken, duuid, userId, email, deviceType) 영속 저장.
// DATABASE_URL 이 있으면 Postgres (Neon), 없으면 로컬 파일(ephemeral).
// 한 콘솔 = 한 계정. 한 행만 유지(id=1).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), 'data', 'report')
const FILE = join(DATA_DIR, 'console-auth.json')

let pool = null
let backend = 'file'

export async function init() {
  const url = process.env.DATABASE_URL
  if (!url) {
    backend = 'file'
    console.log('[db] DATABASE_URL 없음 — 로컬 파일 사용(재배포 때 사라짐)')
    return
  }
  const { default: pg } = await import('pg')
  pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }, // Neon 기본 self-signed-like cert
    max: 3,
    idleTimeoutMillis: 30000,
  })
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_auth (
      id          integer PRIMARY KEY,
      oauth_token text,
      refresh_token text,
      user_id     text,
      duuid       text,
      email       text,
      device_type text,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
  backend = 'pg'
  console.log('[db] Postgres 준비 완료 (Neon)')
}

export function usingPg() { return backend === 'pg' }
export function status() { return { backend, hasPool: !!pool } }

export async function loadCred() {
  if (backend === 'pg') {
    const r = await pool.query('SELECT oauth_token, refresh_token, user_id, duuid, email, device_type FROM report_auth WHERE id=1')
    if (!r.rows.length) return null
    const row = r.rows[0]
    return {
      oauthToken: row.oauth_token || '',
      refreshToken: row.refresh_token || '',
      userId: row.user_id || '',
      duuid: row.duuid || '',
      email: row.email || '',
      deviceType: row.device_type || 'tablet',
    }
  }
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch (e) { return null }
}

export async function saveCred(cred) {
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_auth (id, oauth_token, refresh_token, user_id, duuid, email, device_type, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         oauth_token = EXCLUDED.oauth_token,
         refresh_token = EXCLUDED.refresh_token,
         user_id = EXCLUDED.user_id,
         duuid = EXCLUDED.duuid,
         email = EXCLUDED.email,
         device_type = EXCLUDED.device_type,
         updated_at = now()`,
      [cred.oauthToken || '', cred.refreshToken || '', cred.userId || '', cred.duuid || '', cred.email || '', cred.deviceType || 'tablet'],
    )
    return
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(cred))
}

export async function clearCred() {
  if (backend === 'pg') {
    await pool.query('DELETE FROM report_auth WHERE id=1')
    return
  }
  try { writeFileSync(FILE, '{}') } catch (e) {}
}
