# Instagram Media Downloader

Instagram에서 사진, 영상, Reels, Stories를 원클릭으로 다운로드하는 Chrome 확장프로그램.

## 지원 페이지

- `/p/POST_ID` — 일반 포스트 (사진, 동영상, 캐러셀)
- `/reel/REEL_ID` — Reels
- `/tv/TV_ID` — IGTV
- `/用户名/story/SORY_ID` — Stories (로그인 필요할 수 있음)

## 주요 기능

- **멀티 스트래티지 추출**: SSR JSON → DOM video/img → network capture → embed fallback
- **고해상도**: `image_versions2.candidates`에서 최고 해상도 자동 선택
- **DASH 매니페스트**: 스트리밍 영상도 DASH manifest에서 MP4 URL 추출
- **캐러셀 지원**: 앨범형 포스트의 모든 사진/영상 다운로드
- **호버 버튼**: 마우스 오버하면 다운로드 버튼 표시
- **썸네일 프리뷰**: 팝업에서 바로 영상/사진 확인

## 설치

1. `chrome://extensions/` 열기
2. **Developer mode** ON
3. **Load unpacked** → 이 폴더 선택

## 테스트 방법

1. Instagram 포스트/Reel 열기
2. 확장아이콘 클릭 → 미디어 목록 확인
3. 개별 Save 또는 "모두 다운로드" 클릭

## Referer 헤더

Instagram CDN은 `Referer: https://www.instagram.com/` 요구함.
`background.js`의 `download()` 함수에서 `fetch`로 blob 변환 후 다운로드하여 해결.

## Referer 없는 경우 (MV3 제한)

MV3 service worker에서는 arbitrary Referer 설정이 불가.
`fetch()`로 Instagram CDN에서 blob 가져온 후 다운로드하는 방식으로 우회.

## 디버깅

content script debug bar: 좌측 상단 핑크색 줄
- `scan v:N i:N` — 비디오/이미지 스캔 수
- 페이지 이동 시 자동 갱신

## 파일 구조

```
instagram-media-downloader/
├── manifest.json      # MV3 확장 설정
├── background.js       # Service worker: 다운로드, 네트워크 캡처
├── content.js         # Content script: DOM 스캔, 버튼 부착
├── popup.html/js      # 팝업 UI
├── content.css        # 호버 버튼 스타일
└── icons/             # 아이콘
```

## 스택

- Manifest V3
- Chrome Extensions API (downloads, webRequest, scripting)
- Vanilla JS — 외부 의존성 없음
