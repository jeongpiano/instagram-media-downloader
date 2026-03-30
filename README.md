# Instagram Media Downloader v3

Instagram에서 사진, 영상, Reels, Stories를 원클릭으로 다운로드하는 Chrome 확장프로그램.

## 지원 페이지

- `/p/POST_ID` — 일반 포스트 (사진, 동영상, 캐러셀)
- `/reel/REEL_ID` — Reels
- `/tv/TV_ID` — IGTV
- `/사용자명/story/` — Stories

## 주요 기능 (v3 변경사항)

- **Shadow DOM 관통 (v3 핵심 수정)**: Instagram이 웹 컴포넌트(web components)의 shadow root 안에 미디어를 렌더링하여 기존 `querySelectorAll("video")`가 비어 반환되는 문제 해결. `Element.prototype.attachShadow` 인터셉트로 shadow root 생성 시 즉시 스캔
- **멀티 레벨 shadow DOM**: 15단계 깊이递归로 중첩 shadow root까지 탐색
- **호버 버튼 자동 부착**: shadow root 안팎 모든 미디어 요소에 다운로드 버튼 오버레이
- **HLS/DASH 스트리밍 지원**: m3u8 매니페스트 → MP4 세그먼트 추출 폴백
- **GraphQL API 폴백**: Instagram 내부 API (`/media/{id}/info/`)에서 영상 URL 직접 획득
- **멀티 스트래티지 추출**: GraphQL → SSR JSON → DOM → network capture → embed fallback
- **고해상도**: `image_versions2.candidates` / `display_resources`에서 최고 해상도 자동 선택
- **캐러셀 지원**: 앨범형 포스트의 모든 사진/영상 다운로드

## 설치

1. `chrome://extensions/` 열기
2. **Developer mode** ON
3. **Load unpacked** → 이 폴더 선택
4. 버전이 v3.0.0으로 올라가 있으면 정상

## 디버깅

content script debug bar: 좌측 상단 핑크색 줄
- `shadow:N dom:N bg:N` — shadow root/표준 DOM/background-image 스캔 수
- 페이지 이동 시 자동 갱신
- Instagram 페이지에서 **우클릭 → Inspect** → Console에서 `[IMD v3]` 로그 확인

## 파일 구조

```
instagram-media-downloader/
├── manifest.json      # MV3 확장 설정 (v3.0.0)
├── background.js     # Service worker: 다운로드, HLS, GraphQL
├── content.js        # Content script: Shadow DOM 관통, 호버 버튼 부착
├── popup.html/js     # 팝업 UI
├── content.css       # 호버 버튼 스타일
└── icons/            # 아이콘
```

## 스택

- Manifest V3
- Chrome Extensions API (downloads, webRequest, scripting)
- Vanilla JS — 외부 의존성 없음
