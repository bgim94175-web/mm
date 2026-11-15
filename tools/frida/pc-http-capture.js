// PC KakaoTalk.exe 의 HTTPS 요청을 평문 바이트 그대로 뜨는 frida.
//
// 노리는 것 ─ POST https://open.kakao.com/c/fraud/report/chatLogs 의 완성된 요청:
//   · 요청 라인 (POST /c/fraud/report/chatLogs HTTP/1.1)
//   · 헤더 전부 (Authorization·User-Agent·S·C·A·X-VC·Content-Length 등)
//   · 바디 (JSON 평문)
// 그 바이트를 `sender/src/report-openchat.mjs` 가 만드는 payload 와 bytewise diff.
//
// 쓰임:
//   pip install frida-tools
//   카카오톡 PC 켠 상태에서:
//     frida -l tools/frida/pc-http-capture.js "KakaoTalk.exe" --no-pause
//   그 다음 카카오톡 오픈챗에서 "신고하고 나가기" 한 번 실행.
//
// 원리:
//   KakaoTalk.exe 는 HTTP(S) 요청을 SChannel(secur32.dll) 로 TLS 암호화해서 보낸다.
//   `EncryptMessage` 가 암호화 **직전** 호출되고, 그 안에 평문 버퍼가 들어온다.
//   거기서 "POST /c/fraud/report/chatLogs" 로 시작하는 요청만 필터링 → 통째로 출력.
//
// 이미 있는 pc-loco-capture.js 의 hookSchannel() 과 같은 지점이지만, LOCO BSON 필터 대신
// HTTP 요청 라인 필터만 켠다. 둘 중 하나만 돌리면 됨 (동시에 돌려도 상관없음).
//
// pinning 안 깨도 됨 — EncryptMessage 는 TLS 핸드셰이크 뒤 평문 레이어라
// 카카오톡 쪽 cert pinning 유무와 무관하게 평문이 보인다.

'use strict'

const TARGET_PATHS = ['/c/fraud/report/chatLogs']  // 여기 추가하면 다른 경로도 덤프
const DUMP_ALL_HTTP = false                         // true 로 두면 모든 HTTP 요청 덤프
const MAX_DUMP = 16384

function looksLikeHttp(bytes) {
  // 첫 몇 바이트가 HTTP method 로 시작하는지
  if (bytes.length < 8) return false
  const head = String.fromCharCode.apply(null, new Uint8Array(bytes.slice(0, 8)))
  return /^(GET |POST |PUT |HEAD |DELETE |PATCH )/.test(head)
}

function matchesTarget(bytes) {
  if (DUMP_ALL_HTTP) return true
  // 요청 라인 안에 TARGET_PATHS 중 하나가 들어가는지
  const head = String.fromCharCode.apply(null, new Uint8Array(bytes.slice(0, Math.min(bytes.length, 512))))
  const firstLine = head.split('\r\n')[0] || ''
  for (const p of TARGET_PATHS) if (firstLine.indexOf(p) >= 0) return true
  return false
}

function toHex(bytes) {
  let s = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i++) {
    const b = view[i]
    s += (b < 16 ? '0' : '') + b.toString(16)
  }
  return s
}

function toUtf8(bytes) {
  // 가능하면 utf8, 안 되면 바이트 그대로 (헤더는 ASCII 라 그냥 String.fromCharCode 로 충분)
  try {
    const dec = new TextDecoder('utf-8', { fatal: false })
    return dec.decode(new Uint8Array(bytes))
  } catch (e) {
    return String.fromCharCode.apply(null, new Uint8Array(bytes))
  }
}

function dumpHttp(pv, cb) {
  if (cb < 8 || cb > 1048576) return
  let bytes
  try { bytes = pv.readByteArray(cb) } catch (e) { return }
  if (!bytes) return
  if (!looksLikeHttp(bytes)) return
  if (!matchesTarget(bytes)) return

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('[HTTP_OUT] ' + cb + ' bytes (TLS 평문, EncryptMessage 직전)')
  console.log('--- text ---')
  console.log(toUtf8(bytes.slice(0, Math.min(cb, MAX_DUMP))))
  console.log('--- hex (앞 ' + Math.min(cb, MAX_DUMP) + ' 바이트) ---')
  console.log(toHex(bytes.slice(0, Math.min(cb, MAX_DUMP))))
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

// Hook: secur32!EncryptMessage — SChannel TLS 암호화 직전의 평문
function hookSchannel() {
  const em = Module.findExportByName('secur32.dll', 'EncryptMessage')
  if (!em) return console.log('[!] secur32.EncryptMessage 못 찾음')
  Interceptor.attach(em, {
    onEnter(args) {
      try {
        // args[1] = SecBufferDesc* { ulVersion u32, cBuffers u32, pBuffers SecBuffer* }
        // SecBuffer = { cbBuffer u32, BufferType u32, pvBuffer* }
        // SECBUFFER_DATA = 1 (평문)
        const desc = args[1]
        const cBuffers = desc.add(4).readU32()
        const pBuffers = desc.add(8).readPointer()
        const ptrSize = Process.pointerSize
        const stride = 8 + ptrSize  // cb(4) + type(4) + pv(ptr)
        for (let i = 0; i < cBuffers; i++) {
          const b = pBuffers.add(i * stride)
          const btype = b.add(4).readU32()
          if (btype !== 1) continue  // SECBUFFER_DATA 만
          const cb = b.readU32()
          const pv = b.add(8).readPointer()
          dumpHttp(pv, cb)
        }
      } catch (e) { /* 무음 */ }
    },
  })
  console.log('[+] hook secur32.EncryptMessage')
}

// Hook 보조: WinHTTP — 카카오톡이 WinHTTP 쓸 경우 요청 시점 로그 (헤더만, 참고용)
function hookWinhttp() {
  const send = Module.findExportByName('winhttp.dll', 'WinHttpSendRequest')
  if (!send) return  // 안 쓰면 그냥 건너뜀
  Interceptor.attach(send, {
    onEnter(args) {
      try {
        const lpszHeaders = args[1]
        const dwHeadersLength = args[2].toInt32()
        if (lpszHeaders.isNull() || dwHeadersLength <= 0) return
        // dwHeadersLength = -1 이면 null-terminated, 양수면 WCHAR 길이
        const len = dwHeadersLength === -1 ? 2048 : Math.min(dwHeadersLength * 2, 4096)
        const hdr = lpszHeaders.readUtf16String(len / 2)
        if (hdr && hdr.indexOf('report') >= 0) {
          console.log('[WINHTTP] SendRequest headers: ' + hdr)
        }
      } catch (e) {}
    },
  })
  console.log('[+] hook winhttp.WinHttpSendRequest')
}

console.log('[*] pc-http-capture starting')
console.log('[*] target paths: ' + TARGET_PATHS.join(', ') + (DUMP_ALL_HTTP ? ' (+ ALL)' : ''))
hookSchannel()
hookWinhttp()
console.log('[*] 이제 카카오톡 오픈챗에서 "신고하고 나가기" 한 번 실행하세요.')
console.log('[*] POST /c/fraud/report/chatLogs 가 걸리면 요청 라인·헤더·바디가 전부 뜹니다.')
console.log('[*] 그 출력과 /report/openchat-fire 의 sent 를 bytewise diff.')
