# 서정대 비자서류검증

최종합격자의 비자(체류자격 변경) 신청서류 스캔 PDF를 올리면 쪽마다 서류 종류를 나누고 **통과 · 주의 · 확인 필요 · 불가 · 누락**을 표시하는 사이트입니다.

- 사이트(이동): https://seojeong-visa.blowinds33.workers.dev/ — 이 GitHub Pages 주소는 새 주소로 안내만 합니다.
- 올린 서류와 판정 결과는 **사용하는 브라우저 안에만** 저장됩니다. 이 저장소와 사이트에는 학생 자료가 없습니다.
- 서류 판독(PaddleOCR)도 브라우저 안에서 하므로 서류가 외부로 나가지 않고 API 키·사용료가 없습니다.
- 처음 접속하면 판독 모델(약 18MB)을 한 번 내려받습니다. 1쪽에 약 10~20초 걸립니다(PC 사양에 따라 다름).
- 최신 Chrome 또는 Edge를 권장합니다.

원본 코드와 요구사항 기록은 비공개 저장소 `seojeong-work`의 `apps/visa-web`, `docs/비자서류검증_요구사항정의서.md`에 있습니다. 이 저장소는 배포본이므로 고칠 때는 원본에서 고쳐 다시 올립니다.

사용한 공개 소프트웨어: PaddleOCR 모델(Apache-2.0), onnxruntime-web(MIT), pdf.js(Apache-2.0), SheetJS(Apache-2.0), coi-serviceworker(MIT).
