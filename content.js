/*
 * Content script - Instagram Media Downloader v1
 * Extracts media URLs from:
 *   - SSR JSON blocks (application/json scripts)
 *   - __entry__.js React hydration data
 *   - DOM video/img elements
 *   - OpenGraph/meta tags for single-image posts
 */

(() => {
  "use strict";

  const PROCESSED = "data-imd";
  const WRAP_CLASS = "imd-wrap";
  const BTN_CLASS = "imd-btn";
  const VISIBLE_CLASS = "imd-visible";

  // Instagram CDN domains
  const CDN_PATTERN = /cdninstagram\.com|fbcdn\.net|scontent\.instagram\.com/i;

  let lastUrl = location.href;
  let scanTimer = null;
  let isNavigating = false;

  // ── DEBUG bar ──
  const dbg = document.createElement("div");
  dbg.id = "imd-debug";
  Object.assign(dbg.style, {
    position: "fixed", top: "0", left: "0", zIndex: "999999",
    background: "#E1306C", color: "#fff", padding: "6px 12px",
    fontSize: "12px", fontFamily: "monospace", pointerEvents: "none"
  });
  (document.body || document.documentElement).appendChild(dbg);
  function setDebug(msg) { dbg.textContent = `[IMD] ${msg}`; }
  setDebug("loading…");

  init();

  function init() {
    setDebug("init");
    extractMediaFromPage();
    scheduleScan();

    // MutationObserver: React/Virtual DOM re-renders
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) onNavigate();
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });

    // History API: SPA navigation
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return result;
    };
    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return result;
    };

    window.addEventListener("popstate", () => {
      if (location.href !== lastUrl) onNavigate();
    });
  }

  function onNavigate() {
    if (isNavigating) return;
    isNavigating = true;
    lastUrl = location.href;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    cleanup();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        extractMediaFromPage();
        scheduleScan();
        isNavigating = false;
      });
    });
  }

  // ── Unified media extraction ──
  // Instagram page data lives in <script type="application/json" data-sjs> or similar
  function extractMediaFromPage() {
    const media = []; // { url, type, thumb, y }

    // 1. Scan ALL JSON scripts on the page
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        digMedia(JSON.parse(script.textContent), media, 0);
      } catch { /* skip */ }
    }

    // 2. Look for __entry__.js data (older Instagram structure)
    for (const script of document.querySelectorAll('script')) {
      const src = script.src || "";
      const text = script.textContent || "";
      if (src.includes("__entry") || text.includes('"video_versions"') || text.includes('"image_versions2"')) {
        try {
          // Try to find JSON objects within the script
          const matches = text.matchAll(/"(video_versions|image_versions2|carousel_media)":\s*\{/g);
          for (const m of matches) {
            // Extract a reasonable JSON substring around the match
            const start = Math.max(0, m.index - 10);
            const chunk = text.slice(start, start + 50000);
            try {
              digMedia(JSON.parse(chunk), media, 0);
            } catch {
              // Try parsing the whole script text as JSON fragments
              const fragments = text.matchAll(/\{[^{}]*"(video_versions|image_versions2|carousel_media)"[^{}]*\{[^{}]{10,}\}/g);
              for (const f of fragments) {
                try { digMedia(JSON.parse(f[0]), media, 0); } catch { }
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    // 3. OpenGraph / meta tags (for single-image posts with og:image)
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    if (ogImage && CDN_PATTERN.test(ogImage)) {
      media.push({ url: ogImage, type: "image", thumb: ogImage, y: media.length });
    }

    if (media.length) {
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try { chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails }); } catch (_) {}
    }
  }

  // ── Recursive JSON digger ──
  function digMedia(obj, out, depth) {
    if (depth > 25 || !obj || typeof obj !== "object") return;

    // Video: video_versions array (highest quality)
    if (Array.isArray(obj.video_versions)) {
      // video_versions is ordered by quality; last item is typically best
      const best = obj.video_versions[obj.video_versions.length - 1];
      if (best?.url) {
        out.push({
          url: best.url,
          type: "video",
          thumb: best.thumbnail_url || best.thumb || null,
          y: out.length
        });
      }
      return;
    }

    // Single video_url field
    if (typeof obj.video_url === "string" && obj.video_url) {
      out.push({ url: obj.video_url, type: "video", thumb: null, y: out.length });
      return;
    }

    // Video dash (adaptive streaming manifest)
    if (typeof obj.video_dash_manifest === "string" && obj.video_dash_manifest) {
      try {
        const manifest = JSON.parse(obj.video_dash_manifest);
        const reps = manifest?.Representation || [];
        const mp4s = reps.filter((r) => r.BaseURL?.includes(".mp4"));
        if (mp4s.length) {
          const best = mp4s[mp4s.length - 1];
          if (best.BaseURL) {
            // BaseURL in DASH manifest is often relative
            const base = obj.video_url || location.href;
            const url = best.BaseURL.startsWith("http") ? best.BaseURL : new URL(best.BaseURL, base).href;
            out.push({ url, type: "video", thumb: null, y: out.length });
          }
        }
      } catch { /* skip */ }
    }

    // Image: image_versions2 candidates (carousel posts, feed images)
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        // Last candidate is highest resolution
        const best = cands[cands.length - 1] || cands[0];
        if (best?.url) {
          out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
        }
      }
      return;
    }

    // Legacy: image_versions (Instagram used this in older versions)
    if (obj.image_versions?.candidates) {
      const cands = obj.image_versions.candidates;
      if (cands.length) {
        const best = cands[cands.length - 1] || cands[0];
        if (best?.url) {
          out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
        }
      }
      return;
    }

    // Carousel / album: nested media array
    if (Array.isArray(obj.carousel_media)) {
      for (const m of obj.carousel_media) digMedia(m, out, depth + 1);
      return;
    }

    // Story media
    if (Array.isArray(obj.reel_media) || Array.isArray(obj.stories)) {
      const storyArr = obj.reel_media || obj.stories;
      for (const m of storyArr) digMedia(m, out, depth + 1);
      return;
    }

    // Thread/conversation media (Instagram DMs)
    if (obj.threads?.["0"]?.items) {
      for (const item of obj.threads["0"].items) digMedia(item, out, depth + 1);
      return;
    }

    // Recurse
    if (Array.isArray(obj)) {
      for (const v of obj) digMedia(v, out, depth + 1);
    } else {
      for (const k of Object.keys(obj)) digMedia(obj[k], out, depth + 1);
    }
  }

  // ── DOM scan: attach buttons ──
  function scheduleScan() {
    if (scanTimer) { clearTimeout(scanTimer); }
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 1000);
  }

  function scan() {
    setDebug(`scan v:${document.querySelectorAll("video").length} i:${document.querySelectorAll("img").length}`);

    // Videos
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      if (getComputedStyle(video).position === "static") {
        video.style.position = "relative";
      }
      attachOverlay(video, video, "video");
    }

    // Images — large CDN images only
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      if (src.includes("/t51.2885-19/")) continue; // profile pic
      if (src.includes("s150x150")) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150) continue;

      img.setAttribute(PROCESSED, "image");
      const container = findContainer(img);
      if (container) attachOverlay(container, img, "image");
    }
  }

  function findContainer(el) {
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 150) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  // ── Overlay button ──
  function attachOverlay(container, mediaEl, mediaType) {
    const isVideo = mediaType === "video";

    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS + (isVideo ? " imd-video" : "");

    const label = isVideo ? "Video" : "Photo";
    const icon = isVideo ? ICON_VIDEO_DL : ICON_IMG_DL;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.innerHTML = `${icon}<span>${label}</span>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isVideo) {
        downloadVideo(mediaEl, btn);
      } else {
        downloadImage(mediaEl, btn);
      }
    });

    wrap.appendChild(btn);
    container.appendChild(wrap);

    const show = () => wrap.classList.add(VISIBLE_CLASS);
    const hide = () => {
      setTimeout(() => {
        if (!wrap.matches(":hover") && !mediaEl.matches(":hover")) {
          wrap.classList.remove(VISIBLE_CLASS);
        }
      }, 200);
    };
    mediaEl.addEventListener("mouseenter", show);
    mediaEl.addEventListener("mouseleave", hide);
    wrap.addEventListener("mouseenter", show);
    wrap.addEventListener("mouseleave", hide);

    // Video: capture src changes + poster
    if (isVideo) {
      const srcObs = new MutationObserver(() => {
        const s = mediaEl.currentSrc || mediaEl.src || "";
        const poster = mediaEl.poster || "";
        if (s && !s.startsWith("blob:")) {
          const msg = { type: "EXTRACT_FROM_SCRIPTS", urls: [s] };
          if (poster) msg.thumbnails = { [s]: poster };
          try { chrome.runtime.sendMessage(msg); } catch (_) {}
        }
      });
      srcObs.observe(mediaEl, { attributes: true, attributeFilter: ["src", "poster"] });
    }
  }

  // ── Download: Image ──
  async function downloadImage(img, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    let url = getBestImageUrl(img);
    if (!url) {
      showStatus(btn, prev, "No image found", 2000);
      return;
    }

    const filename = buildFilename("jpg");
    const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
    if (resp?.ok) {
      showStatus(btn, prev, `${ICON_CHECK}<span>Saved!</span>`, 2500);
    } else {
      showStatus(btn, prev, "<span>Failed</span>", 2000);
    }
  }

  function getBestImageUrl(img) {
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const cands = srcset.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        const w = parseInt(parts[1]) || 0;
        return { url: parts[0], w };
      });
      cands.sort((a, b) => b.w - a.w);
      if (cands[0]?.url) return cands[0].url;
    }
    return img.src || img.currentSrc || "";
  }

  // ── Download: Video (multi-strategy) ──
  async function downloadVideo(video, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    try {
      let url = "";

      // Strategy 1: video element's direct src
      url = getNonBlobSrc(video);

      // Strategy 2: look in nearby JSON scripts
      if (!url) url = findVideoUrlFromScriptsNear(video);

      // Strategy 3: network-captured URLs
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const urls = captured?.urls || [];
        if (urls.length) url = urls[urls.length - 1];
      }

      // Strategy 4: embed fallback
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
        const embedUrls = embed?.videoUrls || [];
        if (embedUrls.length) url = embedUrls[0];
      }

      if (!url) {
        showStatus(btn, prev, "No video found", 2500);
        return;
      }

      const filename = buildFilename("mp4");
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      if (resp?.ok) {
        showStatus(btn, prev, `${ICON_CHECK}<span>Saved!</span>`, 2500);
      } else {
        showStatus(btn, prev, "<span>Failed</span>", 2500);
      }
    } catch (err) {
      console.error("[IMD]", err);
      showStatus(btn, prev, "<span>Error</span>", 2000);
    }
  }

  function getNonBlobSrc(video) {
    const src = video.currentSrc || video.src || "";
    if (src && !src.startsWith("blob:")) return src;
    const source = video.querySelector("source");
    if (source) {
      const s = source.src || source.getAttribute("src") || "";
      if (s && !s.startsWith("blob:")) return s;
    }
    return "";
  }

  function findVideoUrlFromScriptsNear(video) {
    let postNode = video;
    for (let i = 0; i < 10 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" ||
          postNode.tagName === "MAIN" ||
          (postNode.id && /post|article|entry|item|media/i.test(postNode.id))) {
        break;
      }
      postNode = postNode.parentElement;
    }
    if (!postNode) return "";

    const scripts = postNode.querySelectorAll ? postNode.querySelectorAll('script[type="application/json"]') : [];
    for (const script of scripts) {
      try {
        const urls = [];
        digMedia(JSON.parse(script.textContent), urls, 0);
        for (const item of urls) {
          if (item.type === "video" && item.url) return item.url;
        }
      } catch { /* skip */ }
    }
    return "";
  }

  // ── Helpers ──
  function buildFilename(ext) {
    const parts = location.pathname.split("/").filter(Boolean);
    // Instagram URL patterns: /p/POST_ID/, /reel/REEL_ID/, /tv/TV_ID/, /reels/REELS_ID/
    const postIdx = Math.max(
      parts.indexOf("p"),
      parts.indexOf("reel"),
      parts.indexOf("tv"),
      parts.indexOf("reels"),
      parts.indexOf("stories")
    );
    const postId = postIdx !== -1 && parts[postIdx + 1] ? parts[postIdx + 1] : "post";
    return `instagram/${postId}_${Date.now()}.${ext}`;
  }

  function showStatus(btn, restoreHtml, html, delay) {
    btn.innerHTML = html;
    setTimeout(() => { btn.innerHTML = restoreHtml; btn.disabled = false; }, delay);
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => {
        resolve(chrome.runtime.lastError ? null : r);
      });
    });
  }

  function cleanup() {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }

  // ── Inline SVG icons ──
  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="imd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
})();
