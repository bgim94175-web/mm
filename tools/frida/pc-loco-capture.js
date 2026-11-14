// PC KakaoTalk.exe 의 LOCO 송수신 패킷을 평문으로 뜨는 frida 스크립트.
// 쓰임:
//   frida -l pc-loco-capture.js -p <KakaoTalk.exe pid>
//   또는 frida -l pc-loco-capture.js "KakaoTalk.exe" --no-pause
//
// 노리는 것 ─ BLSPAMS 신고 바디 (st,c,ls,ss,lds,lts,sr,bi) 의 실제 BSON 바이트.
// 그 바이트와 우리 콘솔의 /report/msg-dump hex 를 바이트 단위로 비교해서,
// 서버가 -301 (INTERNAL_SERVER_ERROR_BO) 뱉는 원인이 우리 BSON 인코딩 차이인지 확인한다.
//
// PC KakaoTalk 은 LOCO 를 SSL/TLS 가 아닌 **AES-GCM 자체 암호** 로 보내지만,
// 암호는 루프백 socket 에 쓰기 직전 WSASend/send 안에서 이뤄진다. 그 전 단계(encodePacket 뒤,
// AES 전) 에서 plaintext 를 뜨거나, SChannel/EncryptMessage 로 TLS 레이어 (checkin 서버와의 TLS)를 함께 떠서
// 어느 쪽이든 LOCO 22B 헤더 + BSON 을 보면 된다.
//
// 기존 리포 tools/frida/pc-voiceroom-http.js 와 같은 패턴. 쓰는 API:
//   Secur32.dll        EncryptMessage / DecryptMessage           (SChannel TLS)
//   ws2_32.dll         send / recv / WSASend / WSARecv           (raw socket)
//   bcrypt.dll         BCryptEncrypt                              (AES-GCM LOCO)
//
// 출력: 콘솔에 `LOCO_OUT method=BLSPAMS 22b_header=... body_bson=<hex>` 형식.

'use strict'

const LOCO_HEADER = 22
const MAX_DUMP = 4096
const WATCH_METHODS = ['BLSPAMS', 'WRITE', 'SHIP', 'SETMETA', 'CHATONROOM', 'SYNCMSG', 'LEAVE']

// ────────────────────────────────────────────────────────────────────────────
// util: LOCO 22B 헤더 읽기 → { packetId, statusCode, method, bodyType, bodyLen }
function parseLocoHeader(ptr) {
  const packetId = ptr.readU32()
  const statusCode = ptr.add(4).readS16()
  const methodBytes = ptr.add(6).readByteArray(11)
  const method = String.fromCharCode.apply(null, new Uint8Array(methodBytes)).replace(/\0.*$/, '')
  const bodyType = ptr.add(17).readU8()
  const bodyLen = ptr.add(18).readU32()
  return { packetId, statusCode, method, bodyType, bodyLen }
}

function dumpPacket(dir, buf, len) {
  if (len < LOCO_HEADER) return
  // 패킷 앞 22바이트가 LOCO 헤더처럼 생겼는지 확인 (bodyType==0, method 가 ASCII 대문자)
  const bodyType = buf.add(17).readU8()
  if (bodyType !== 0) return  // BSON 만
  const methodBytes = buf.add(6).readByteArray(11)
  const method = String.fromCharCode.apply(null, new Uint8Array(methodBytes)).replace(/\0.*$/, '')
  if (!/^[A-Z]+$/.test(method)) return
  if (WATCH_METHODS.indexOf(method) < 0) return

  const hdr = parseLocoHeader(buf)
  if (hdr.bodyLen + LOCO_HEADER > len) return
  const bodyHex = Buffer.from(buf.add(LOCO_HEADER).readByteArray(Math.min(hdr.bodyLen, MAX_DUMP))).toString('hex')
  console.log('LOCO_' + dir + ' pid=' + hdr.packetId + ' st=' + hdr.statusCode + ' method=' + hdr.method
    + ' bodyLen=' + hdr.bodyLen + ' body_bson=' + bodyHex)
}

// ────────────────────────────────────────────────────────────────────────────
// Hook 1: ws2_32.send(socket, buf, len, flags) — TLS 전 raw 가 여기 지나갈 수 있음
function hookSend() {
  const send = Module.findExportByName('ws2_32.dll', 'send')
  if (!send) return console.log('[!] ws2_32.send not found')
  Interceptor.attach(send, {
    onEnter(args) {
      const buf = args[1], len = args[2].toInt32()
      try { dumpPacket('SEND', buf, len) } catch (e) {}
    },
  })
  console.log('[+] hook ws2_32.send')
}

function hookRecv() {
  const recv = Module.findExportByName('ws2_32.dll', 'recv')
  if (!recv) return console.log('[!] ws2_32.recv not found')
  Interceptor.attach(recv, {
    onLeave(retval) {
      if (retval.toInt32() <= 0) return
      // recv 의 buf 는 onEnter 에서 args[1] 로 기억해야 함 — 간단히 생략, SEND 로 충분
    },
  })
  console.log('[+] hook ws2_32.recv')
}

// Hook 2: Secur32!EncryptMessage — TLS 평문이 지나감 (booking/checkin)
function hookSchannel() {
  const em = Module.findExportByName('secur32.dll', 'EncryptMessage')
  if (!em) return console.log('[!] secur32.EncryptMessage not found')
  Interceptor.attach(em, {
    onEnter(args) {
      // args[1] = SecBufferDesc*. SecBufferDesc { ulVersion, cBuffers, pBuffers* }
      // pBuffers[i].cbBuffer / pvBuffer — SECBUFFER_DATA (type=1) 이 평문.
      try {
        const desc = args[1]
        const cBuffers = desc.add(4).readU32()
        const pBuffers = desc.add(8).readPointer()
        for (let i = 0; i < cBuffers; i++) {
          const b = pBuffers.add(i * 16)  // SecBuffer = { cbBuffer u32, BufferType u32, pvBuffer* }
          const btype = b.add(4).readU32()
          if (btype !== 1) continue  // SECBUFFER_DATA
          const cb = b.readU32()
          const pv = b.add(8).readPointer()
          if (cb < LOCO_HEADER || cb > 65536) continue
          dumpPacket('TLS_OUT', pv, cb)
        }
      } catch (e) {}
    },
  })
  console.log('[+] hook secur32.EncryptMessage')
}

// Hook 3: bcrypt!BCryptEncrypt — LOCO AES-GCM 자체 암호 전 평문
function hookBcrypt() {
  const be = Module.findExportByName('bcrypt.dll', 'BCryptEncrypt')
  if (!be) return console.log('[!] bcrypt.BCryptEncrypt not found')
  Interceptor.attach(be, {
    onEnter(args) {
      // BCryptEncrypt(hKey, pbInput, cbInput, pPaddingInfo, pbIV, cbIV, pbOutput, cbOutput, pcbResult, dwFlags)
      try {
        const pbInput = args[1]
        const cbInput = args[2].toInt32()
        if (cbInput < LOCO_HEADER || cbInput > 65536) return
        dumpPacket('AES_IN', pbInput, cbInput)
      } catch (e) {}
    },
  })
  console.log('[+] hook bcrypt.BCryptEncrypt')
}

// ────────────────────────────────────────────────────────────────────────────
console.log('[*] pc-loco-capture starting')
console.log('[*] watching methods: ' + WATCH_METHODS.join(', '))
hookSend()
hookRecv()
hookSchannel()
hookBcrypt()
console.log('[*] 이제 카카오톡에서 메시지 "신고하고 나가기" 를 한 번만 실행하세요.')
console.log('[*] 콘솔에 LOCO_* method=BLSPAMS 라인이 뜨면 body_bson= 뒤 hex 를 저장하고')
console.log('[*] mm-iwo1.onrender.com 의 "BSON hex 덤프" 결과와 바이트 단위로 비교.')
