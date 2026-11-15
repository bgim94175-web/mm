// Android 카카오톡의 오픈챗 "신고하고 나가기" HTTP 요청을 바이트 단위로 뜨는 frida.
// 쓰임:
//   adb push <apk> /sdcard/… (설치돼 있으면 생략)
//   frida-server 를 Android 에 실행 (루팅 or Magisk)
//   Android 카카오톡 켠 상태에서:
//     frida -U -n com.kakao.talk -l tools/frida/android-openchat-http-capture.js
//     (혹은 -f com.kakao.talk --no-pause 로 최초부터 훅)
//
// 노리는 것 ─ POST https://open.kakao.com/c/fraud/report/chatLogs 의 완성된 요청:
//   · method
//   · URL (full)
//   · 헤더 전부 (OkHttp 가 interceptor 체인 끝에 실제로 꽂는 헤더까지)
//   · 바디 바이트 (RequestBody.writeTo 직전 — gzip/charset 변환 이후 raw)
//
// 그 바이트와 `sender/src/report-openchat.mjs` 가 만드는 payload 를 diff:
//   헤더 → 이름·순서·값 비교. 우리에 없는 헤더(X-VC, S/C 포맷 등) 가 결정적일 수 있음.
//   바디 → BSON 이 아니라 JSON 이므로 바로 utf8 로 보임. 필드 순서·공백·escape 가 전부 보임.
//
// 필요시 LOCO 가 아닌 HTTP 경로 (/c/fraud/…) 만 필터해서 노이즈 제거.

'use strict'

const TARGET_PATH = '/c/fraud/report/chatLogs'  // 이 경로만 덤프 (BLSPAMS LOCO 노이즈 제거)
const DUMP_ALL_HTTP = false                      // true 로 두면 모든 OkHttp 요청 덤프

function hex(bytes) {
  const B = Java.use('java.lang.String')
  // byte[] → hex (java 쪽에서 조립하면 빠름)
  const sb = Java.use('java.lang.StringBuilder').$new()
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i] & 0xff
    if (b < 16) sb.append('0')
    sb.append(Java.use('java.lang.Integer').toHexString(b))
  }
  return sb.toString()
}

Java.perform(function () {
  console.log('[*] android-openchat-http-capture 로드')

  // OkHttp3 RealCall 또는 Call 구현체. R8 로 패키지는 보통 그대로 유지됨.
  // 대안: okhttp3.internal.connection.RealCall (3.14+), okhttp3.RealCall (3.x 구버전)
  let RealCall
  try {
    RealCall = Java.use('okhttp3.internal.connection.RealCall')
  } catch (e1) {
    try {
      RealCall = Java.use('okhttp3.RealCall')
    } catch (e2) {
      console.log('[!] RealCall 못 찾음: ' + e1.message + ' / ' + e2.message)
      return
    }
  }
  console.log('[+] RealCall 훅: ' + RealCall.$className)

  const Buffer = Java.use('okio.Buffer')

  function dumpRequest(req, tag) {
    try {
      const url = req.url().toString()
      const method = req.method()

      if (!DUMP_ALL_HTTP && url.indexOf(TARGET_PATH) < 0) return

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('[' + tag + '] ' + method + ' ' + url)

      // ── 헤더 (interceptor 체인 끝에서 실제 꽂힌 상태) ──
      const headers = req.headers()
      const n = headers.size()
      console.log('--- headers (' + n + ') ---')
      for (let i = 0; i < n; i++) {
        console.log(headers.name(i) + ': ' + headers.value(i))
      }

      // ── 바디 바이트 ──
      const body = req.body()
      if (body !== null) {
        const buf = Buffer.$new()
        body.writeTo(buf)
        // okio.Buffer.size() 는 Java long. frida JS 로 받으면 2^53 초과 위험 — Number() 로 래핑.
        // 신고 바디는 수 KB 라 실제로 넘을 일은 없지만 가드.
        const size = Number(buf.size())
        console.log('--- body (' + size + ' bytes, content-type='
          + (body.contentType() !== null ? body.contentType().toString() : 'null') + ') ---')

        // utf8 로 뜨기 (JSON 이므로 바로 읽힘)
        const clone = buf.clone()
        const utf8 = clone.readUtf8()
        console.log(utf8)

        // 바이트 단위 비교용 hex (처음 2048 바이트만)
        const take = Math.min(size, 2048)
        const arr = buf.readByteArray(take)
        console.log('--- body hex (' + take + ') ---')
        console.log(hex(arr))
      } else {
        console.log('--- body: null ---')
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    } catch (e) {
      console.log('[!] dump 실패: ' + e)
    }
  }

  // execute (동기) · enqueue (비동기) 둘 다
  RealCall.execute.implementation = function () {
    dumpRequest(this.request(), 'SYNC')
    return this.execute()
  }
  RealCall.enqueue.implementation = function (cb) {
    dumpRequest(this.request(), 'ASYNC')
    return this.enqueue(cb)
  }

  console.log('[*] 이제 카카오톡 앱에서 오픈챗 메시지 "신고하고 나가기" 한 번만 실행하세요.')
  console.log('[*] 경로 ' + TARGET_PATH + ' 가 걸리면 헤더·바디·hex 가 전부 뜹니다.')
  console.log('[*] 그 출력과 mm-iwo1.onrender.com 의 /report/openchat-fire sent 를 바이트 단위로 비교.')
})
