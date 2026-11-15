# BlueStacks 로 카카오톡 오픈챗 신고 바이트 캡쳐

`android-openchat-http-capture.js` 를 **BlueStacks (x86/x86_64)** 에서 돌려 실제 앱의 `/c/fraud/report/chatLogs` 요청을 뽑는 방법.

frida 스크립트 자체는 **Java API 훅이라 CPU 아키텍처 무관** — x86_64 BlueStacks 에서도 그대로 작동한다. 필요한 건 (1) adb 가 BlueStacks 에 붙고 (2) BlueStacks 안에서 **x86_64 frida-server** 가 돌고 (3) 카카오톡이 BlueStacks 의 ARM 변환 레이어 (ROSETTA 아님, BlueStacks 내장) 위에서 실행된다는 것.

## 1. BlueStacks 쪽 세팅

1. **BlueStacks 설정 → 환경설정 → 고급** 에서 "Android 디버그 브릿지(ADB)" **켜기**. 포트가 표시된다 (보통 `5555`, `5558`, `5560` … 인스턴스마다 다름).
2. **root 모드 켜기** — BlueStacks 5 기준: 설정 → 환경설정 → 고급 → "루트 접속 허용". 적용 후 BlueStacks 재시작.
3. **카카오톡** 설치 — BlueStacks 내부 Play Store 에서 `com.kakao.talk` 설치. 성공하면 x86 호환 번들이 깔림. 실패하면 `adb install kakaotalk_26.8.x.apk` 로 수동 설치 (ARM-only 빌드여도 BlueStacks 변환 레이어가 돌림, 속도만 느림).

## 2. PC 쪽 — adb + frida 연결

```bash
# BlueStacks ADB 에 붙기 (포트는 BlueStacks 알림에 나온 값)
adb connect 127.0.0.1:5555
adb devices   # ← "127.0.0.1:5555  device" 떠야 함

# frida-tools 설치 (PC)
pip3 install --user frida-tools
```

## 3. BlueStacks 안에 frida-server 올리기 (x86_64)

```bash
# GitHub Releases 에서 PC 의 frida-tools 와 같은 메이저 버전의 x86_64 server 받기.
# 예: frida-tools 17.x 면 frida-server 17.x
FRIDA_VER=$(frida --version)   # 예: 17.4.0
curl -L "https://github.com/frida/frida/releases/download/${FRIDA_VER}/frida-server-${FRIDA_VER}-android-x86_64.xz" \
  -o /tmp/frida-server.xz
unxz /tmp/frida-server.xz

# BlueStacks 로 푸시 + 실행
adb push /tmp/frida-server /data/local/tmp/frida-server
adb shell "chmod +x /data/local/tmp/frida-server"
adb shell "su -c '/data/local/tmp/frida-server -D &'"
# ↑ "su" 가 안 되면 BlueStacks 설정에서 루트 체크 재확인
```

확인:

```bash
frida-ps -U | head -20    # com.kakao.talk 같은 BlueStacks 프로세스가 나와야 함
```

## 4. 카카오톡 훅 + 신고 실행

PC 터미널에서:

```bash
cd /path/to/mm   # 이 레포 루트
frida -U -n com.kakao.talk -l tools/frida/android-openchat-http-capture.js
```

- `-U` = USB/네트워크 디바이스 (adb connect 로 붙은 BlueStacks 포함)
- `-n com.kakao.talk` = 이미 떠 있는 카카오톡 프로세스에 attach
- 연결되면 `[*] android-openchat-http-capture 로드` 뜸

이제 **BlueStacks 안에서** 카카오톡 → 오픈챗 방 → 문제 메시지 → "신고하고 나가기" **한 번만** 실행. PC 터미널에 아래 포맷이 뜬다:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[ASYNC] POST https://open.kakao.com/c/fraud/report/chatLogs
--- headers (N) ---
A: android/26.8.x/ko
Accept: application/json
...
--- body (NNN bytes, content-type=application/json; charset=UTF-8) ---
{"category":"VIOLENT","linkId":...,"chatId":...,"chatLogInfos":"..."}
--- body hex (NNN) ---
7b22636174...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 5. 봇 쪽 바이트와 diff

`mm-iwo1.onrender.com` 콘솔 → 방·메시지 선택 → "🧪 앱 ↔ 봇 바이트 비교" 섹션의 **"봇 요청 바이트 덤프"** 버튼. 같은 포맷으로 뜬다. 양쪽을 텍스트 파일에 저장해서:

```bash
diff bot.txt app.txt
```

### 판정

| diff 결과 | 결론 |
|---|---|
| **헤더·body·hex 전부 동일** | 위조 자체는 서버 도달 100% 확정 → 서버가 (u,l) 로 DB 조회해 silent-reject 또는 심사큐에 뭉개는 중. 계정 풀 늘려 fanout 임계 돌파가 유일한 길. |
| header 수·이름·값 다름 | 그 헤더가 심사 자료 분기 기준 — 우리 코드에 추가 |
| body 필드 수 다름 | APK 2차 분석에서 놓친 숨은 필드 — 즉시 코드 패치 |
| body JSON 순서·escape 다름 | kotlinx-serialization 버전 차이. 순서를 그대로 맞춰야 할 수도 |

## 트러블슈팅

- **frida-ps 가 빈 리스트**: adb connect 안 됨. `adb devices` 재확인. BlueStacks 포트가 다를 수 있음 (설정에서 봄).
- **"unable to find frida-server"**: frida-server 가 안 떠 있음. `adb shell "ps | grep frida"` 로 확인. 실행 시 `su -c` 안 되면 루트 재설정.
- **x86_64 바이너리 다운로드 실패**: 네트워크 proxy / GitHub rate-limit. 다른 미러 (예: [frida-server mirrors]) 사용.
- **카카오톡이 BlueStacks 를 "에뮬레이터" 로 감지해서 로그인 거부**: BlueStacks 설정에서 "휴대폰처럼 보이게" (기기 정보 변경) 켜고 재시도. 또는 이미 로그인된 상태로 유지.
- **훅은 걸리는데 신고 POST 가 안 뜸**: DUMP_ALL_HTTP = true 로 바꿔서 전체 OkHttp 트래픽 확인. `/c/fraud/report/` 외 다른 경로로 변경됐는지 (APK 업데이트 후 라우트 바뀜 가능성).

## 옛날 리소스 활용

이전에 BlueStacks 로 캡쳐한 적 있다면:
- 그때 쓴 **frida-server 바이너리** (`/data/local/tmp/frida-server`) 가 BlueStacks 내부에 남아있을 수 있음 → `adb shell ls /data/local/tmp/` 로 확인, 있으면 재사용
- 그때 쓴 **카카오톡 APK 버전** 이 BlueStacks 에 깔려 있으면 그대로 써도 됨 (26.x 신고 바디는 동일). 단 해외계정·신규 로그인은 피하고 **이미 로그인된 상태에서 신고만 캡쳐**.
