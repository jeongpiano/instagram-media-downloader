/*
 * Content script - Instagram Media Downloader v2 (Fixed)
 * Fixes: data-videoUrl DOM, HLS/DASH streaming, GraphQL relay_payload, embed fallback
 */
(() => {
  "use strict";

  const PROCESSED = "data-imd";
  const WRAP_CLASS = "imd-wrap";
  const BTN_CLASS = "imd-btn";
  const VISIBLE_CLASS = "imd-visible";

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

    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) onNavigate();
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });

    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return result;
    };
    const origReplaceState = history.replaceState;
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
  function extractMediaFromPage() {
    const media = []; // { url, type, thumb, y }

    // 1. Instagram GraphQL relay_payload (new Instagram structure)
    extractGraphQLMedia(media);

    // 2. Legacy JSON script blocks
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try { digMedia(JSON.parse(script.textContent), media, 0); } catch { /* skip */ }
    }

    // 3. Inline JSON in script tags (window._sharedData fallback)
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || "";
      // Try to extract JSON from window._sharedData or similar patterns
      const sharedDataMatch = text.match(/window\._sharedData\s*=\s*({.+?});/s);
      if (sharedDataMatch) {
        try { digMedia(JSON.parse(sharedDataMatch[1]), media, 0); } catch { /* skip */ }
      }
      // Also try parsing entire script as JSON (fragments)
      if (text.startsWith("{") && text.endsWith("}")) {
        try { digMedia(JSON.parse(text), media, 0); } catch { /* skip */ }
      }
    }

    // 4. OpenGraph / meta tags
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    if (ogImage && CDN_PATTERN.test(ogImage)) {
      media.push({ url: ogImage, type: "image", thumb: ogImage, y: media.length });
    }
    const ogVideo = document.querySelector('meta[property="og:video"]')?.content;
    if (ogVideo && (ogVideo.includes(".mp4") || ogVideo.includes(".m3u8"))) {
      media.push({ url: ogVideo, type: "video", thumb: null, y: media.length });
    }

    if (media.length) {
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try { chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails }); } catch (_) {}
    }
  }

  // ── FIX 3: GraphQL relay_payload parser ──
  function extractGraphQLMedia(out) {
    // Instagram injects a __UIContainer script with full post data as GraphQL
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || "";
      // Pattern: {"__bbox":{"result":{"data":{"x":{" threading key
      const bboxMatches = text.matchAll(/"__bbox"\s*:\s*({.+?})\s*[,}]/g);
      for (const m of bboxMatches) {
        try {
          const bbox = JSON.parse(m[1]);
          // Navigate: bbox.result.data.[some_key].threads_context.thread_items[].post
          digGraphQL(bbox, out, 0);
        } catch { /* skip */ }
      }

      // Pattern: window.__additionalData
      const addDataMatch = text.match(/window\.__additionalData\s*=\s*({.+?});/s);
      if (addDataMatch) {
        try { digMedia(JSON.parse(addDataMatch[1]), out, 0); } catch { /* skip */ }
      }

      // Pattern: data-sjs data attribute on script tags (Instagram's main hydration)
      if (script.type === "application/json" || script.getAttribute("data-sjs")) {
        try { digMedia(JSON.parse(script.textContent), out, 0); } catch { /* skip */ }
      }
    }

    // Also look for JSON-LD structured data
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { digMedia(JSON.parse(el.textContent), out, 0); } catch { /* skip */ }
    }
  }

  function digGraphQL(obj, out, depth) {
    if (depth > 30 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const v of obj) digGraphQL(v, out, depth + 1); return; }
    if (typeof obj !== "object") return;

    // Navigate GraphQL structure: thread_items[].post, or shortcode_media
    if (obj.thread_items) {
      for (const item of obj.thread_items) digGraphQL(item, out, depth + 1);
      return;
    }
    if (obj.post) { digGraphQL(obj.post, out, depth + 1); return; }
    if (obj.shortcode_media) { digGraphQL(obj.shortcode_media, out, depth + 1); return; }

    // Standard Instagram media fields
    if (obj.video_versions) {
      const best = obj.video_versions[obj.video_versions.length - 1];
      if (best?.url) out.push({ url: best.url, type: "video", thumb: best.thumbnail_url || null, y: out.length });
      return;
    }
    if (obj.video_url) { out.push({ url: obj.video_url, type: "video", thumb: obj.thumbnail_url || null, y: out.length }); return; }
    if (obj.carousel_media) { for (const m of obj.carousel_media) digGraphQL(m, out, depth + 1); return; }
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      const best = cands[cands.length - 1] || cands[0];
      if (best?.url) out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
      return;
    }
    if (obj.display_resources) {
      const best = obj.display_resources[obj.display_resources.length - 1];
      if (best?.src) out.push({ url: best.src, type: "image", thumb: best.src, y: out.length });
      return;
    }

    for (const k of Object.keys(obj)) digGraphQL(obj[k], out, depth + 1);
  }

  // ── FIX 1+2: Enhanced recursive JSON digger (HLS, video_url, GraphQL) ──
  function digMedia(obj, out, depth) {
    if (depth > 30 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const v of obj) digMedia(v, out, depth + 1); return; }

    // Video: video_versions (highest quality)
    if (Array.isArray(obj.video_versions)) {
      const best = obj.video_versions[obj.video_versions.length - 1];
      if (best?.url) {
        out.push({ url: best.url, type: "video", thumb: best.thumbnail_url || best.thumb || null, y: out.length });
      }
      return;
    }

    // Video: direct video_url field (used in Reels, Stories)
    if (typeof obj.video_url === "string" && obj.video_url) {
      out.push({ url: obj.video_url, type: "video", thumb: obj.thumbnail_url || obj.image || null, y: out.length });
      return;
    }

    // HLS / DASH adaptive streaming
    if (typeof obj.video_dash_manifest === "string" && obj.video_dash_manifest) {
      try {
        const manifest = JSON.parse(obj.video_dash_manifest);
        const reps = manifest?.Representation || [];
        // Find MP4 video representations
        const mp4s = reps.filter((r) =>
          (r.BaseURL && (r.BaseURL.includes(".mp4") || r.mimeType?.includes("mp4")))
        );
        if (mp4s.length) {
          const best = mp4s[mp4s.length - 1];
          const base = obj.video_url || location.href;
          const url = best.BaseURL.startsWith("http") ? best.BaseURL : new URL(best.BaseURL, base).href;
          out.push({ url, type: "video", thumb: obj.thumbnail_url || null, y: out.length });
        }
      } catch { /* skip */ }
    }

    // HLS m3u8 manifest (sometimes stored as direct string)
    if (typeof obj.video_hls_manifest === "string" && obj.video_hls_manifest) {
      // Send to background for m3u8 → mp4 extraction
      try {
        chrome.runtime.sendMessage({
          type: "EXTRACT_HLS",
          manifestUrl: obj.video_hls_manifest,
          postUrl: location.href.split("?")[0]
        });
      } catch { /* skip */ }
    }

    // Image: image_versions2 (carousel posts, feed images)
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        const best = cands[cands.length - 1] || cands[0];
        if (best?.url) out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
      }
      return;
    }

    // Image: legacy image_versions
    if (obj.image_versions?.candidates) {
      const cands = obj.image_versions.candidates;
      if (cands.length) {
        const best = cands[cands.length - 1] || cands[0];
        if (best?.url) out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
      }
      return;
    }

    // Image: display_resources (Instagram video posts)
    if (Array.isArray(obj.display_resources)) {
      const best = obj.display_resources[obj.display_resources.length - 1];
      if (best?.src) out.push({ url: best.src, type: "image", thumb: best.src, y: out.length });
      return;
    }

    // Carousel / album
    if (Array.isArray(obj.carousel_media)) {
      for (const m of obj.carousel_media) digMedia(m, out, depth + 1);
      return;
    }

    // Story / reel media
    if (Array.isArray(obj.reel_media) || Array.isArray(obj.stories)) {
      const arr = obj.reel_media || obj.stories;
      for (const m of arr) digMedia(m, out, depth + 1);
      return;
    }

    // Threads/conversation media (DMs)
    if (obj.threads?.["0"]?.items) {
      for (const item of obj.threads["0"].items) digMedia(item, out, depth + 1);
      return;
    }

    // Recurse
    for (const k of Object.keys(obj)) digMedia(obj[k], out, depth + 1);
  }

  // ── DOM scan ──
  function scheduleScan() {
    if (scanTimer) { clearTimeout(scanTimer); }
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 1200);
  }

  function scan() {
    setDebug(`scan v:${document.querySelectorAll("video").length} i:${document.querySelectorAll("img").length}`);
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      if (getComputedStyle(video).position === "static") video.style.position = "relative";
      attachOverlay(video, video, "video");
    }
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      if (src.includes("/t51.2885-19/")) continue;
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
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS + (isVideo ? " imd-video" : "");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    const icon = isVideo ? ICON_VIDEO_DL : ICON_IMG_DL;
    const label = isVideo ? "Video" : "Photo";
    btn.innerHTML = `${icon}<span>${label}</span>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isVideo) downloadVideo(mediaEl, btn);
      else downloadImage(mediaEl, btn);
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
    if (!url) { showStatus(btn, prev, "No image found", 2000); return; }
    const filename = buildFilename("jpg");
    const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
    showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
  }

  function getBestImageUrl(img) {
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const cands = srcset.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        return { url: parts[0], w: parseInt(parts[1]) || 0 };
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

      // Strategy 1: video element's direct src (most reliable)
      url = getNonBlobSrc(video);

      // Strategy 2: data-videoUrl / data-video-url attribute (FIX 1: new Instagram)
      if (!url) url = findVideoUrlFromDOM(video);

      // Strategy 3: nearby JSON scripts
      if (!url) url = findVideoUrlFromScriptsNear(video);

      // Strategy 4: network-captured URLs
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const urls = captured?.urls || [];
        if (urls.length) url = urls[urls.length - 1];
      }

      // Strategy 5: Instagram GraphQL API fallback (FIX 4)
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const gql = await sendMsg({ type: "FETCH_GRAPHQL_MEDIA", postUrl });
        if (gql?.url) url = gql.url;
        else {
          // Strategy 6: embed fallback (updated URL)
          const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
          const embedUrls = embed?.videoUrls || [];
          if (embedUrls.length) url = embedUrls[0];
        }
      }

      if (!url) { showStatus(btn, prev, "No video found", 2500); return; }

      const filename = buildFilename("mp4");
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
    } catch (err) {
      console.error("[IMD]", err);
      showStatus(btn, prev, "<span>Error</span>", 2000);
    }
  }

  // FIX 1: data-videoUrl / data-video-url attribute
  function findVideoUrlFromDOM(el) {
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      // Check various Instagram data attribute patterns
      for (const attr of ["data-videoUrl", "data-video-url", "data-video-url", "data-video-src", "data-src", "data-url"]) {
        const val = node.getAttribute?.(attr);
        if (val && !val.startsWith("blob:") && (val.includes(".mp4") || val.includes("/v/") || val.includes(".m3u8"))) {
          return val;
        }
      }
      // Also check dataAttributes object
      if (node.dataset) {
        for (const key of Object.keys(node.dataset)) {
          const val = node.dataset[key];
          if (val && !val.startsWith("blob:") && (val.includes(".mp4") || val.includes("/v/") || val.includes(".m3u8"))) {
            return val;
          }
        }
      }
      node = node.parentElement;
    }
    return "";
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
    for (let i = 0; i < 12 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" || postNode.tagName === "MAIN" ||
          (postNode.id && /post|article|entry|item|media|thread|reel|clip/i.test(postNode.id))) {
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
    const idx = Math.max(
      parts.indexOf("p"), parts.indexOf("reel"), parts.indexOf("tv"),
      parts.indexOf("reels"), parts.indexOf("stories")
    );
    const postId = idx !== -1 && parts[idx + 1] ? parts[idx + 1] : "post";
    return `instagram/${postId}_${Date.now()}.${ext}`;
  }

  function showStatus(btn, restoreHtml, html, delay) {
    btn.innerHTML = html;
    setTimeout(() => { btn.innerHTML = restoreHtml; btn.disabled = false; }, delay);
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
    });
  }

  function cleanup() {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }

  // ── Icons ──
  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="imd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;
})();
