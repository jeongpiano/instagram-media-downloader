document.addEventListener("DOMContentLoaded", async () => {
  const content = document.getElementById("content");
  const status = document.getElementById("status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("instagram.com")) {
    status.textContent = "Instagram 페이지에서 사용해주세요.";
    return;
  }

  // ── Collect media from CURRENT PAGE ONLY ──
  const videoSet = new Set();
  const imageSet = new Set();
  const allThumbnails = {};

  // Scan current page DOM
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPage
    });
    if (result?.result) {
      result.result.videos.forEach((u) => videoSet.add(u));
      result.result.images.forEach((u) => imageSet.add(u));
      Object.assign(allThumbnails, result.result.thumbnails || {});

      // For each video shortcode, fetch embed endpoint to get correct CDN URL
      // (replaces SSR-ordered placeholder or blob: fallback with the real URL)
      const shortcodes = result.result.shortcodes || {};
      const seenCodes = new Set();
      for (const [oldUrl, code] of Object.entries(shortcodes)) {
        if (!code || seenCodes.has(code)) continue;
        seenCodes.add(code);
        try {
          // Try /reel/, /p/, /tv/ in order — reels only respond to /reel/CODE/embed
          let newUrl = null;
          for (const t of ["reel", "p", "tv"]) {
            const r = await chrome.runtime.sendMessage({
              type: "FETCH_EMBED_VIDEOS",
              postUrl: `https://www.instagram.com/${t}/${code}/`
            });
            if (r?.videoUrls?.length) { newUrl = r.videoUrls[0]; break; }
          }
          if (newUrl) {
            // Swap placeholder/old URL with real URL in videoSet
            videoSet.delete(oldUrl);
            videoSet.add(newUrl);
            if (allThumbnails[oldUrl]) {
              allThumbnails[newUrl] = allThumbnails[oldUrl];
              delete allThumbnails[oldUrl];
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    status.textContent = "페이지 스캔 실패. 새로고침 후 다시 시도해주세요.";
    return;
  }

  // Supplement: merge thumbnails + network-captured post images from background
  // (t51.2885-15 = Instagram post/feed images — includes carousel slides the user swiped through)
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    if (r?.thumbnails) Object.assign(allThumbnails, r.thumbnails);
    (r?.imageUrls || []).forEach((u) => {
      if (u.includes("/t51.2885-15/") && !u.includes("s150x150") && !u.includes("s320x320")) {
        imageSet.add(u);
        if (!allThumbnails[u]) allThumbnails[u] = u;
      }
    });
  } catch {}

  // Fallback: if no media found at all (e.g. single post page), use network + embed
  if (videoSet.size === 0 && imageSet.size === 0) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
      (r?.urls || []).forEach((u) => {
        // Only add full video URLs, not DASH segments
        if ((u.includes(".mp4") || u.includes("/v/t16/")) &&
            !u.includes("bytestart") && !u.includes("-seg-")) {
          videoSet.add(u);
        }
      });
      (r?.imageUrls || []).forEach((u) => {
        if (!u.includes("/t51.2885-19/")) imageSet.add(u);
      });
    } catch {}

    if (videoSet.size === 0) {
      try {
        const postUrl = tab.url.split("?")[0];
        const r = await chrome.runtime.sendMessage({ type: "FETCH_EMBED_VIDEOS", postUrl });
        (r?.videoUrls || []).forEach((u) => videoSet.add(u));
      } catch {}
    }
  }

  const videos = [...videoSet];
  const images = [...imageSet];
  const total = videos.length + images.length;

  if (total === 0) {
    content.innerHTML = `
      <div class="status">미디어를 찾지 못했습니다.</div>
      <button class="scan-btn" id="rescan">다시 검색</button>`;
    document.getElementById("rescan")?.addEventListener("click", () => location.reload());
    return;
  }

  const postId = extractPostId(tab.url);
  let html = "";

  // Videos section
  if (videos.length) {
    html += `<div class="section-title">Videos (${videos.length})</div>`;
    html += `<ul class="media-list">`;
    videos.forEach((url, i) => {
      const thumb = allThumbnails[url] || null;
      html += mediaItem(url, i, "video", `Video ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  // Images section
  if (images.length) {
    html += `<div class="section-header">
      <div class="section-title">Photos (${images.length})</div>
      <button class="dl-carousel" id="dl-carousel">📷 캐러셀 전체 다운로드</button>
    </div>`;
    html += `<ul class="media-list">`;
    images.forEach((url, i) => {
      const thumb = allThumbnails[url] || url;
      html += mediaItem(url, videos.length + i, "photo", `Photo ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  // Download all
  html += `
    <div class="dl-all-wrap">
      <button class="dl-all" id="dl-all">모두 다운로드 (${total})</button>
    </div>`;

  content.innerHTML = html;

  // Fix thumbnails: proxy through background to avoid CORS, with error fallback
  content.querySelectorAll(".media-thumb img").forEach(async (img) => {
    const origSrc = img.getAttribute("src");
    if (!origSrc) return;

    img.addEventListener("error", async () => {
      // Try fetching via background script (has host_permissions)
      try {
        const r = await chrome.runtime.sendMessage({ type: "FETCH_THUMBNAIL", url: origSrc });
        if (r?.ok && r.dataUrl) {
          img.src = r.dataUrl;
          img.style.display = "block";
          return;
        }
      } catch {}
      // Final fallback: show placeholder
      img.style.display = "none";
      const placeholder = img.parentElement.querySelector(".thumb-placeholder");
      if (placeholder) placeholder.style.display = "flex";
    });
  });

  content.querySelectorAll(".media-thumb video").forEach((vid) => {
    vid.addEventListener("error", () => {
      vid.style.display = "none";
      const placeholder = vid.parentElement.querySelector(".thumb-placeholder");
      if (placeholder) placeholder.style.display = "flex";
    });
  });

  // All media URLs in order
  const allMedia = [
    ...videos.map((u) => ({ url: u, ext: "mp4", thumb: allThumbnails[u] || null })),
    ...images.map((u) => ({ url: u, ext: "jpg", thumb: allThumbnails[u] || u }))
  ];

  // Individual buttons
  content.querySelectorAll(".dl-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const m = allMedia[idx];
      btn.disabled = true;
      btn.textContent = "...";
      const filename = `instagram/${postId}_${idx + 1}.${m.ext}`;
      const r = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      btn.textContent = r?.ok ? "완료!" : "실패";
      if (r?.ok) btn.className = "dl-btn done";
      else btn.disabled = false;
    });
  });

  // Download all
  document.getElementById("dl-all")?.addEventListener("click", async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = "다운로드 중...";
    for (let i = 0; i < allMedia.length; i++) {
      const m = allMedia[i];
      const filename = `instagram/${postId}_${i + 1}.${m.ext}`;
      await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      await new Promise((r) => setTimeout(r, 200));
    }
    b.textContent = "완료!";
    b.style.background = "#27ae60";
    content.querySelectorAll(".dl-btn").forEach((btn) => {
      btn.textContent = "완료!";
      btn.className = "dl-btn done";
    });
  });

  // Carousel: auto-advance through all slides and download every photo
  document.getElementById("dl-carousel")?.addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "슬라이드 스캔 중...";

    let urls = [];
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: autoAdvanceCarousel
      });
      urls = result?.result || [];
    } catch {
      btn.textContent = "스캔 실패";
      btn.disabled = false;
      return;
    }

    if (!urls.length) {
      btn.textContent = "사진 없음";
      return;
    }

    for (let i = 0; i < urls.length; i++) {
      btn.textContent = `다운로드 중 (${i + 1}/${urls.length})`;
      const filename = `instagram/${postId}_photo_${i + 1}.jpg`;
      await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: urls[i], filename });
      await new Promise((r) => setTimeout(r, 250));
    }

    btn.textContent = `완료! (${urls.length}장)`;
    btn.style.background = "#1a7a46";
  });
});

function mediaItem(url, idx, type, label, thumbUrl) {
  const short = shortUrl(url);
  const typeClass = type === "video" ? "type-video" : "type-photo";
  const typeLabel = type === "video" ? "MP4" : "JPG";

  let thumbHtml;
  if (thumbUrl) {
    if (type === "video") {
      // Video thumbnail: use poster image, NOT video element (avoids CORS issues)
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy"><div class="thumb-placeholder" style="display:none"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>`;
    } else {
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy"><div class="thumb-placeholder" style="display:none"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`;
    }
  } else {
    const icon = type === "video"
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
    thumbHtml = `<div class="thumb-placeholder">${icon}</div>`;
  }

  return `
    <li class="media-item">
      <div class="media-thumb">${thumbHtml}</div>
      <div class="media-info">
        <span class="media-type ${typeClass}">${typeLabel}</span>
        <span style="font-size:13px;font-weight:600;margin-left:4px">${label}</span>
        <div class="media-url" title="${esc(url)}">${esc(short)}</div>
      </div>
      <button class="dl-btn" data-idx="${idx}">Save</button>
    </li>`;
}

function shortUrl(url) {
  try { return new URL(url).pathname.split("/").pop()?.slice(0, 35) || "media"; }
  catch { return "media"; }
}

// Runs in content script context — returns viewport videos + all article images
function scanPage() {
  const videos = [];
  const images = [];
  const thumbnails = {};
  const shortcodes = {}; // videoUrl -> postCode (for embed endpoint lookup)
  const vh = window.innerHeight;
  const cdnRe = /cdninstagram\.com|fbcdn\.net|scontent[^.]*\.instagram\.com/;

  // Find the article most visible in the current viewport
  function findMainArticle() {
    let best = null, bestH = 0;
    for (const a of document.querySelectorAll("article")) {
      const r = a.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (h > bestH) { bestH = h; best = a; }
    }
    return best;
  }

  // Extract post shortcode — article link → SSR JSON → URL
  function extractCode(el) {
    const article = el.closest("article");
    if (article) {
      const a = article.querySelector('a[href*="/p/"],a[href*="/reel/"],a[href*="/tv/"]');
      if (a) {
        const am = a.href.match(/\/(p|reel|tv|reels)\/([\w-]+)/);
        if (am) return am[2];
      }
    }
    // SSR JSON: parse tree to find "code" sibling of "video_versions"
    // (text-search window approach breaks when "code" is 30k+ chars from "video_versions")
    const ssrEntries = [];
    function collectVideoEntries(obj, d) {
      if (d > 25 || !obj || typeof obj !== "object") return;
      if (Array.isArray(obj.video_versions) && obj.code) {
        const url = obj.video_versions[0]?.url;
        if (url) ssrEntries.push({ code: obj.code, url });
        return;
      }
      for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) collectVideoEntries(v, d + 1);
    }
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try { collectVideoEntries(JSON.parse(s.textContent), 0); } catch {}
    }
    if (ssrEntries.length === 1) return ssrEntries[0].code;
    if (ssrEntries.length > 1) {
      const allVideos = [...document.querySelectorAll("video")];
      const vIdx = allVideos.indexOf(el);
      if (vIdx >= 0 && vIdx < ssrEntries.length) return ssrEntries[vIdx].code;
      const allArticles = [...document.querySelectorAll("article")];
      const aIdx = allArticles.indexOf(article);
      if (aIdx >= 0 && aIdx < ssrEntries.length) return ssrEntries[aIdx].code;
      return ssrEntries[0].code;
    }
    const m = location.pathname.match(/\/(p|reel|tv|reels)\/([\w-]+)/);
    if (m && document.querySelectorAll("video").length <= 1) return m[2];
    if (m) return m[2];
    return "";
  }

  // Best quality URL from a srcset attribute string
  function bestFromSrcset(srcset) {
    if (!srcset) return "";
    const cands = srcset.split(",").map(s => {
      const parts = s.trim().split(/\s+/);
      return { url: parts[0], w: parseInt(parts[1]) || 0 };
    }).filter(c => cdnRe.test(c.url));
    if (!cands.length) return "";
    cands.sort((a, b) => b.w - a.w);
    return cands[0].url;
  }

  // ── Step 1: Extract ALL video/image URLs from SSR JSON (for matching blob: videos) ──
  const ssrVideos = []; // { url, thumb }
  const ssrImages = []; // { url }
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try { digSSR(JSON.parse(s.textContent), 0); } catch {}
  }

  // Regex fallback: extract post image CDN URLs directly from raw SSR JSON text
  // (handles deeply nested / differently structured Instagram JSON)
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    const text = s.textContent;
    // t51.2885-15 = Instagram feed/post images (not profiles, not stories)
    const re = /https:\/\/[^"]*(?:cdninstagram\.com|fbcdn\.net)[^"]*t51\.2885-15[^"]*(?:jpg|webp)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const url = m[0].replace(/\\u0026/g, "&");
      if (!url.includes("s150x150") && !url.includes("s320x320") &&
          !ssrImages.find(i => i.url === url)) {
        ssrImages.push({ url });
      }
    }
  }

  function digSSR(obj, d) {
    if (d > 50 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      const best = obj.video_versions[0];
      if (best?.url) {
        let thumb = null;
        if (obj.image_versions2?.candidates?.length) {
          thumb = obj.image_versions2.candidates[0].url;
        }
        ssrVideos.push({ url: best.url, thumb, code: obj.code || null });
      }
      return;
    }
    if (typeof obj.video_url === "string") {
      ssrVideos.push({ url: obj.video_url, thumb: null });
    }
    if (obj.image_versions2?.candidates) {
      const best = obj.image_versions2.candidates[0];
      if (best?.url) ssrImages.push({ url: best.url });
      return;
    }
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) digSSR(m, d + 1);
      return;
    }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) digSSR(v, d + 1);
  }

  // ── Step 2: Scan DOM videos in viewport ──
  let ssrVideoIdx = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue; // Not in viewport

    let src = v.currentSrc || v.src || "";
    let thumb = v.poster || "";
    const sourceSrc = v.querySelector("source")?.src || "";
    const code = extractCode(v);

    // Strategy 0: content.js stored the CDN URL when this video actually played (most accurate)
    if (v.dataset.imdVideoUrl) {
      src = v.dataset.imdVideoUrl;
      videos.push(src);
      shortcodes[src] = code;
      if (thumb) thumbnails[src] = thumb;
    } else if (src && !src.startsWith("blob:")) {
      // Non-blob src attribute
      videos.push(src);
      shortcodes[src] = code;
      if (thumb) thumbnails[src] = thumb;
    } else if (sourceSrc && !sourceSrc.startsWith("blob:")) {
      videos.push(sourceSrc);
      shortcodes[sourceSrc] = code;
      if (thumb) thumbnails[sourceSrc] = thumb;
      src = sourceSrc;
    } else {
      // blob: video — match to SSR JSON URL by order; shortcode gives embed fallback
      if (ssrVideoIdx < ssrVideos.length) {
        const ssr = ssrVideos[ssrVideoIdx];
        videos.push(ssr.url);
        shortcodes[ssr.url] = ssr.code || code; // prefer code from SSR object itself
        src = ssr.url;
        if (ssr.thumb) thumb = ssr.thumb;
        ssrVideoIdx++;
      } else {
        // No SSR match — store placeholder so embed fallback can fill in later
        if (code) {
          const placeholder = `__embed__${code}`;
          videos.push(placeholder);
          shortcodes[placeholder] = code;
        }
      }
    }

    // Find thumbnail if still missing
    if (src && !thumb) {
      // Walk up DOM to find nearby CDN image (poster frame)
      let parent = v.parentElement;
      for (let i = 0; i < 6 && parent; i++) {
        const img = parent.querySelector("img[src*='cdninstagram'], img[src*='fbcdn']");
        if (img?.src) { thumb = img.src; break; }
        // Also check srcset
        const imgWithSrcset = parent.querySelector("img[srcset*='cdninstagram'], img[srcset*='fbcdn']");
        if (imgWithSrcset) {
          const ss = imgWithSrcset.getAttribute("srcset");
          if (ss) { thumb = ss.split(",")[0].trim().split(/\s+/)[0]; break; }
        }
        parent = parent.parentElement;
      }
    }
    if (src && thumb) thumbnails[src] = thumb;
  }

  // ── Step 3: Scan ALL images inside the most-visible article (captures full carousel) ──
  const mainArticle = findMainArticle();
  const imgScope = mainArticle || document; // fallback: whole doc
  for (const img of imgScope.querySelectorAll("img")) {
    // Best-quality URL from srcset, fallback to src
    let src = bestFromSrcset(img.getAttribute("srcset")) || img.src || img.currentSrc || "";
    if (!cdnRe.test(src)) continue;
    if (src.includes("/t51.2885-19/")) continue; // profile pics
    if (src.includes("s150x150") || src.includes("s320x320")) continue; // tiny thumbnails
    const r = img.getBoundingClientRect();
    const w = r.width || img.naturalWidth || parseInt(img.getAttribute("width")) || 0;
    const h = r.height || img.naturalHeight || parseInt(img.getAttribute("height")) || 0;
    if (w >= 100 && h >= 100) {
      images.push(src);
      thumbnails[src] = src;
    }
  }

  // ── Step 4: Add ALL SSR JSON images (captures full carousel, not just 3 DOM-rendered slides) ──
  for (const item of ssrImages) {
    if (!images.includes(item.url)) {
      images.push(item.url);
      if (!thumbnails[item.url]) thumbnails[item.url] = item.url;
    }
  }

  return { videos: [...new Set(videos)], images: [...new Set(images)], thumbnails, shortcodes };
}

// Runs in content-script context: advances carousel to collect ALL slide image URLs
async function autoAdvanceCarousel() {
  const cdnRe = /cdninstagram\.com|fbcdn\.net/;
  const vh = window.innerHeight;

  // Find most-visible article
  let mainArticle = null, bestH = 0;
  for (const a of document.querySelectorAll("article")) {
    const r = a.getBoundingClientRect();
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (h > bestH) { bestH = h; mainArticle = a; }
  }
  if (!mainArticle) return [];

  // Collect best-quality CDN image URLs currently visible in the article
  function collectImages() {
    const found = [];
    for (const img of mainArticle.querySelectorAll("img")) {
      const srcset = img.getAttribute("srcset") || "";
      let best = "";
      if (srcset) {
        const cands = srcset.split(",").map(s => {
          const p = s.trim().split(/\s+/);
          return { url: p[0], w: parseInt(p[1]) || 0 };
        }).filter(c => cdnRe.test(c.url) && !c.url.includes("t51.2885-19") && !c.url.includes("s150x150") && !c.url.includes("s320x320"));
        if (cands.length) { cands.sort((a, b) => b.w - a.w); best = cands[0].url; }
      }
      if (!best) best = img.src || img.currentSrc || "";
      if (!cdnRe.test(best) || best.includes("t51.2885-19") || best.includes("s150x150") || best.includes("s320x320")) continue;
      const r = img.getBoundingClientRect();
      if ((r.width || img.naturalWidth || 0) < 150) continue;
      if (!found.includes(best)) found.push(best);
    }
    return found;
  }

  // Find Next or Prev slide button
  function findSlideBtn(isNext) {
    const nextLabels = ["Next", "다음", "Siguiente", "Weiter", "Suivant", "次へ", "下一张", "Avanti", "Далее"];
    const prevLabels = ["돌아가기", "Go back", "이전", "Anterior", "Zurück", "Précédent", "前へ", "上一张", "Indietro"];
    for (const label of (isNext ? nextLabels : prevLabels)) {
      const b = mainArticle.querySelector(`button[aria-label="${label}"]`);
      if (b) return b;
    }
    // Position-based fallback
    const ar = mainArticle.getBoundingClientRect();
    for (const btn of mainArticle.querySelectorAll("button")) {
      if (!btn.querySelector("svg")) continue;
      const br = btn.getBoundingClientRect();
      if (isNext  && br.left > ar.right - 90 && br.width > 0 && br.width < 60) return btn;
      if (!isNext && br.right < ar.left + 90 && br.width > 0 && br.width < 60) return btn;
    }
    return null;
  }
  function findNextBtn() { return findSlideBtn(true); }

  // Get total slide count from "1 / N" or "1/N" overlay text
  function getTotalSlides() {
    for (const el of mainArticle.querySelectorAll("*")) {
      if (el.children.length > 0) continue;
      const t = el.textContent.trim();
      const m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (m) return parseInt(m[2]);
    }
    return 0;
  }

  // Go to slide 1 first (user may have scrolled mid-carousel)
  for (let i = 0; i < 30 && findSlideBtn(false); i++) {
    findSlideBtn(false).click();
    await new Promise(r => setTimeout(r, 350));
  }

  const allUrls = new Set(collectImages());

  if (!findNextBtn()) return [...allUrls]; // Not a carousel — return what we have

  const total = getTotalSlides();
  const maxSlides = total > 0 ? total : 20; // cap at 20 if count unknown

  for (let i = 1; i < maxSlides; i++) {
    const btn = findNextBtn();
    if (!btn) break; // Reached the last slide

    btn.click();
    // Wait for slide change via MutationObserver (fast), fall back to 800ms timeout
    await (() => {
      return new Promise(resolve => {
        const key = () => [...mainArticle.querySelectorAll("img")].map(img => img.src + (img.currentSrc || "")).join("|");
        const initial = key();
        const mo = new MutationObserver(() => { if (key() !== initial) { mo.disconnect(); resolve(); } });
        mo.observe(mainArticle, { subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
        setTimeout(() => { mo.disconnect(); resolve(); }, 800);
      });
    })();
    collectImages().forEach(u => allUrls.add(u));

    if (!findNextBtn()) break; // Last slide — no more Next button
  }

  return [...allUrls];
}

function extractPostId(url) {
  const p = new URL(url).pathname.split("/").filter(Boolean);
  // Instagram: /p/CODE/, /reel/CODE/, /tv/CODE/, /reels/CODE/, /stories/USER/ID/
  const postTypes = ["p", "reel", "tv", "reels", "stories"];
  for (let i = 0; i < p.length; i++) {
    if (postTypes.includes(p[i]) && p[i + 1]) return p[i + 1];
  }
  return "instagram";
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
