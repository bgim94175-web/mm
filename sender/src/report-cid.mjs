// ★ v59-A §12 — report-cid.mjs 자리만. 실제 구현은 다음 태스크.
// 목적: POST talk-report/cid/encode. body { serviceCode:"OC", referer:1,
// payload:{ linkId, chatId, chatLogIds:[Long,...] } }.
// cd.b 가 chatLogInfos 문자열을 JSON 배열로 읽어 각 항목의 l 값만 추출해 chatLogIds 로 구성.
// §10 매트릭스 참조 (serviceCode / referer / payload 키 조합).
// 호스트: talk-report 가 어디에 붙어 있는지 미확정 — talk 호스트로 1회 시도 후 폴백.

export async function cidEncode(/* { linkId, chatId, chatLogInfosString } */) {
  throw new Error('v59-A: CID 는 다음 태스크에서 구현 (스텁 상태)')
}
