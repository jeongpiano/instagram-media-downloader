/*
 * Content script - Instagram Media Downloader v3
 * Fixes: Shadow DOM piercing, new Instagram React UI DOM structure
 * Problem: Instagram renders media inside web component shadow roots.
 *   document.querySelectorAll("video") does NOT pierce shadow DOM.
 * Solution: intercept attachShadow(), pierce all shadow roots recursively,
 *   scan inside for media elements, attach shadow-root-aware overlay buttons.
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

  // Track scanned shadow roots to avoid duplicate work
  const scannedShadowRoots = new WeakSet();

  // ── DEBUG bar ──
  const dbg = document.createElement("div");
  dbg.id = "imd-debug";
  Object.assign(dbg.style, {
    position: "fixed", top: "0", left: "0", zIndex: "999999",
    background: "#E1306C", color: "#fff", padding: "6px 12px",
    fontSize: "12px", fontFamily: "monospace", pointerEvents: "none"
  });
  (document.body || document.documentElement).appendChild(dbg);
  function setDebug(msg) { dbg.textContent = `[IMD v3] ${msg}`; }
  setDebug("init");

  // ────────────────────────────────────────────────────────
  // CORE FIX: Shadow DOM piercing
  // ────────────────────────────────────────────────────────

  // Intercept attachShadow — scan immediately when a shadow root is created
  const OrigAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...args) {
    const shadow = OrigAttachShadow.apply(this, args);
    // Scan this shadow root for media elements
    scheduleShadowScan(shadow);
    return shadow;
  };

  // Intercept customElements.define — scan when a new web component is defined
  const OrigDefine = customElements.define.bind(customElements);
  customElements.define = function (name, cls, options) {
    const result = OrigDefine(name, cls, options);
    // After definition, scan all existing shadow roots (they may upgrade)
    requestAnimationFrame(() => scheduleFullScan());
    return result;
  };

  // Recursively pierce all shadow roots and collect elements matching a selector
  function queryDeep(root, selector, depth = 0) {
    if (depth > 15 || !root) return [];
    const results = [];

    // Check if root itself matches (for shadow host elements)
    if (root.matches && selector !== "*") {
      try { if (root.matches(selector)) results.push(root); } catch { /* ignore */ }
    }

    // Query inside this root (works for both DocumentFragment and ShadowRoot)
    try {
      for (const el of root.querySelectorAll(selector)) {
        results.push(el);
      }
    } catch { /* ignore */ }

    // Recurse into all shadow roots found in this root
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          if (!scannedShadowRoots.has(el.shadowRoot)) {
            scannedShadowRoots.add(el.shadowRoot);
            results.push(...queryDeep(el.shadowRoot, selector, depth + 1));
          }
        }
      }
    } catch { /* ignore — shadow may be closed */ }

    return results;
  }

  // Also collect elements that ARE shadow hosts themselves (for overlay targeting)
  function collectShadowHosts(root, depth = 0) {
    if (depth > 15 || !root) return [];
    const results = [];
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          if (!scannedShadowRoots.has(el.shadowRoot)) {
            scannedShadowRoots.add(el.shadowRoot);
            results.push(el); // the shadow host itself
            results.push(...collectShadowHosts(el.shadowRoot, depth + 1));
          }
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  // ────────────────────────────────────────────────────────
  // Shadow-root-aware media scanning
  // ────────────────────────────────────────────────────────

  function scanAllMedia() {
    const results = { videos: [], images: [], stats: { shadow: 0, dom: 0 } };

    // Strategy 1: pierce all shadow roots
    const allVideos = queryDeep(document, "video");
    const allImages = queryDeep(document, "img");
    results.stats.shadow = allVideos.length + allImages.length;

    // Strategy 2: standard DOM scan (for non-shadow elements)
    const domVideos = [...document.querySelectorAll("video")];
    const domImages = [...document.querySelectorAll("img")];
    results.stats.dom = domVideos.length + domImages.length;

    // Strategy 3: Instagram-specific article/section scanning (pierce shadow)
    const articles = queryDeep(document, "article");
    const sections = queryDeep(document, "section[aria-label]");
    const posts = queryDeep(document, '[data-sblock]');
    const mediaContainers = queryDeep(document, '_a8yr _a6hd');

    // Strategy 4: Look for Instagram's div-based video/image representations
    // Instagram uses <div role="presentation"> with background-image for some media
    const bgMedia = queryDeep(document, '[style*="background-image"]');
    const videoContainers = queryDeep(document, 'div[role][tabindex]');
    const reelDivs = queryDeep(document, 'div[aria-label="릴스"]');

    // Deduplicate and filter
    const seenUrls = new Set();
    const addMedia = (el, type) => {
      if (el.hasAttribute && el.hasAttribute(PROCESSED)) return;
      el.setAttribute(PROCESSED, type);
      results[type === "video" ? "videos" : "images"].push(el);
    };

    allVideos.forEach((v) => addMedia(v, "video"));
    allImages.forEach((img) => {
      if (isValidImage(img)) addMedia(img, "image");
    });

    // bg-image divs — extract URL and attach overlay
    bgMedia.forEach((el) => {
      const style = el.getAttribute("style") || "";
      const match = style.match(/url\(["']?(https?:\/\/[^)'"]+)/);
      if (match) {
        const url = match[1];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          attachBgOverlay(el, url, "image");
        }
      }
    });

    const total = results.videos.length + results.images.length;
    setDebug(`shadow:${results.stats.shadow} dom:${results.stats.dom} bg:${bgMedia.length}`);

    // Report URLs to background for popup display
    const mediaUrls = [
      ...results.videos.map((v) => ({
        url: getVideoUrl(v),
        type: "video",
        thumb: v.poster || null
      })),
      ...results.images.map((img) => ({
        url: getBestImageUrl(img),
        type: "image",
        thumb: img.currentSrc || img.src || null
      }))
    ].filter((m) => m.url);

    if (mediaUrls.length) {
      try {
        chrome.runtime.sendMessage({
          type: "EXTRACT_FROM_SCRIPTS",
          urls: mediaUrls.map((m) => m.url),
          thumbnails: Object.fromEntries(mediaUrls.filter((m) => m.thumb).map((m) => [m.url, m.thumb])),
          pageUrl: location.href
        });
      } catch (_) {}
    }

    // Attach overlay buttons
    results.videos.forEach((v) => attachOverlayToVideo(v));
    results.images.forEach((img) => attachOverlayToImage(img));

    return results;
  }

  function isValidImage(img) {
    const src = img.src || img.currentSrc || "";
    if (!src) return false;
    if (!CDN_PATTERN.test(src)) return false;
    if (src.includes("/t51.2885-19/")) return false;
    if (src.includes("s150x150")) return false;
    const rect = img.getBoundingClientRect();
    return rect.width >= 150 && rect.height >= 150;
  }

  function getVideoUrl(video) {
    const src = video.currentSrc || video.src || "";
    if (src && !src.startsWith("blob:")) return src;
    const source = video.querySelector("source");
    if (source) {
      const s = source.src || source.getAttribute("src") || "";
      if (s && !s.startsWith("blob:")) return s;
    }
    // data-videoUrl attribute
    for (const attr of ["data-videoUrl", "data-video-url", "data-src"]) {
      const v = video.getAttribute(attr);
      if (v && !v.startsWith("blob:") && (v.includes(".mp4") || v.includes("/v/"))) return v;
    }
    // dataset
    if (video.dataset) {
      for (const key of Object.keys(video.dataset)) {
        const v = video.dataset[key];
        if (v && !v.startsWith("blob:") && (v.includes(".mp4") || v.includes("/v/"))) return v;
      }
    }
    return "";
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

  // ────────────────────────────────────────────────────────
  // Overlay buttons
  // ────────────────────────────────────────────────────────

  function attachOverlayToVideo(video) {
    const container = findOverlayContainer(video, true);
    if (!container) return;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    attachButton(container, video, "video");
  }

  function attachOverlayToImage(img) {
    const container = findOverlayContainer(img, false);
    if (!container) return;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    attachButton(container, img, "image");
  }

  function attachBgOverlay(el, url, type) {
    if (el.hasAttribute(PROCESSED)) return;
    el.setAttribute(PROCESSED, "bg-" + type);
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    attachButton(el, { _bgUrl: url, tagName: "DIV" }, type);
  }

  function findOverlayContainer(el, isVideo) {
    if (isVideo) return el;
    let node = el.parentElement;
    for (let i = 0; i < 10 && node; i++) {
      const r = node.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 150) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  function attachButton(container, mediaEl, mediaType) {
    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS + (mediaType === "video" ? " imd-video" : "");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    const icon = mediaType === "video" ? ICON_VIDEO_DL : ICON_IMG_DL;
    const label = mediaType === "video" ? "Video" : "Photo";
    btn.innerHTML = `${icon}<span>${label}</span>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (mediaType === "video") downloadVideo(mediaEl, btn);
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

    if (mediaType === "video") {
      const srcObs = new MutationObserver(() => {
        const s = getVideoUrl(mediaEl);
        const poster = mediaEl.poster || "";
        if (s) {
          try {
            chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls: [s], thumbnails: poster ? { [s]: poster } : {} });
          } catch (_) {}
        }
      });
      srcObs.observe(mediaEl, { attributes: true, attributeFilter: ["src", "poster"] });
    }
  }

  // ────────────────────────────────────────────────────────
  // Downloads
  // ────────────────────────────────────────────────────────

  async function downloadImage(mediaEl, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    const isBg = mediaEl._bgUrl;
    const url = isBg || getBestImageUrl(mediaEl);
    if (!url) { showStatus(btn, prev, "No image found", 2000); return; }

    const filename = buildFilename("jpg");
    const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
    showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
  }

  async function downloadVideo(mediaEl, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    try {
      let url = getVideoUrl(mediaEl);

      // Try embedded JSON near the video's shadow host
      if (!url) url = findVideoUrlInContext(mediaEl);

      // Network-captured URLs
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const urls = captured?.urls || [];
        if (urls.length) url = urls[urls.length - 1];
      }

      // GraphQL API
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const gql = await sendMsg({ type: "FETCH_GRAPHQL_MEDIA", postUrl });
        if (gql?.url) url = gql.url;
      }

      // Embed fallback
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
        if (embed?.videoUrls?.length) url = embed.videoUrls[0];
      }

      if (!url) { showStatus(btn, prev, "No video found", 2500); return; }

      const filename = buildFilename("mp4");
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
    } catch (err) {
      console.error("[IMD v3]", err);
      showStatus(btn, prev, "<span>Error</span>", 2000);
    }
  }

  // Walk up DOM (piercing shadow roots) to find video URL context
  function findVideoUrlInContext(el) {
    let node = el;
    for (let i = 0; i < 20 && node; i++) {
      // Check attributes
      for (const attr of ["data-videoUrl", "data-video-url", "data-src", "data-url", "data-video-src"]) {
        const v = node.getAttribute?.(attr);
        if (v && !v.startsWith("blob:") && (v.includes(".mp4") || v.includes("/v/") || v.includes(".m3u8"))) {
          return v;
        }
      }
      // Check dataset
      if (node.dataset) {
        for (const key of Object.keys(node.dataset)) {
          const v = node.dataset[key];
          if (v && !v.startsWith("blob:") && (v.includes(".mp4") || v.includes("/v/"))) return v;
        }
      }
      node = node.parentElement;
    }
    return "";
  }

  // ────────────────────────────────────────────────────────
  // SSR JSON extraction (piercing shadow roots)
  // ────────────────────────────────────────────────────────

  function extractMediaFromPage() {
    const media = [];

    // Scan all JSON scripts — pierce shadow roots
    const allScripts = queryDeep(document, 'script[type="application/json"]');
    allScripts.push(...queryDeep(document, "script"));

    for (const script of allScripts) {
      const text = script.textContent || "";
      if (!text || text.length < 50) continue;

      // window._sharedData
      const sharedDataMatch = text.match(/window\._sharedData\s*=\s*({.+?})\s*;?\s*$/m);
      if (sharedDataMatch) {
        try { digMedia(JSON.parse(sharedDataMatch[1]), media, 0); } catch { /* skip */ }
      }

      // __bbox
      const bboxMatches = text.matchAll(/"__bbox"\s*:\s*({.+?})\s*[,}]/g);
      for (const m of bboxMatches) {
        try { digMedia(JSON.parse(m[1]), media, 0); } catch { /* skip */ }
      }

      // __additionalData
      const addDataMatch = text.match(/window\.__additionalData\s*=\s*({.+?})\s*;?\s*$/m);
      if (addDataMatch) {
        try { digMedia(JSON.parse(addDataMatch[1]), media, 0); } catch { /* skip */ }
      }

      // Plain JSON script blocks
      if (script.getAttribute && script.getAttribute("type") === "application/json") {
        try { digMedia(JSON.parse(text), media, 0); } catch { /* skip */ }
      }
    }

    if (media.length) {
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try {
        chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails, pageUrl: location.href });
      } catch (_) {}
    }
  }

  function digMedia(obj, out, depth) {
    if (depth > 35 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const v of obj) digMedia(v, out, depth + 1); return; }

    if (Array.isArray(obj.video_versions)) {
      const best = obj.video_versions[obj.video_versions.length - 1];
      if (best?.url) out.push({ url: best.url, type: "video", thumb: best.thumbnail_url || best.thumb || null, y: out.length });
      return;
    }
    if (typeof obj.video_url === "string" && obj.video_url) {
      out.push({ url: obj.video_url, type: "video", thumb: obj.thumbnail_url || obj.image || null, y: out.length });
      return;
    }
    if (typeof obj.video_dash_manifest === "string" && obj.video_dash_manifest) {
      try {
        const manifest = JSON.parse(obj.video_dash_manifest);
        const reps = manifest?.Representation || [];
        const mp4s = reps.filter((r) => r.BaseURL?.includes(".mp4") || r.mimeType?.includes("mp4"));
        if (mp4s.length) {
          const best = mp4s[mp4s.length - 1];
          const url = best.BaseURL.startsWith("http") ? best.BaseURL : new URL(best.BaseURL, location.href).href;
          out.push({ url, type: "video", thumb: obj.thumbnail_url || null, y: out.length });
        }
      } catch { /* skip */ }
    }
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
    if (Array.isArray(obj.carousel_media)) { for (const m of obj.carousel_media) digMedia(m, out, depth + 1); return; }
    if (Array.isArray(obj.reel_media) || Array.isArray(obj.stories)) {
      for (const m of (obj.reel_media || obj.stories)) digMedia(m, out, depth + 1);
      return;
    }
    if (obj.threads?.["0"]?.items) { for (const item of obj.threads["0"].items) digMedia(item, out, depth + 1); return; }

    for (const k of Object.keys(obj)) digMedia(obj[k], out, depth + 1);
  }

  // ────────────────────────────────────────────────────────
  // Scheduling
  // ────────────────────────────────────────────────────────

  // Scan a shadow root for media elements
  function scheduleShadowScan(shadowRoot) {
    scannedShadowRoots.add(shadowRoot);
    setTimeout(() => {
      scanAllMedia();
    }, 500);
  }

  // Full scan — pierce all shadow roots on the page
  function scheduleFullScan() {
    if (scanTimer) { clearTimeout(scanTimer); }
    scanTimer = setTimeout(() => { scanTimer = null; scanAllMedia(); }, 1500);
  }

  // Initial + navigation scan
  function scheduleScan() {
    if (scanTimer) { clearTimeout(scanTimer); }
    scanTimer = setTimeout(() => { scanTimer = null; scanAllMedia(); extractMediaFromPage(); }, 1500);
  }

  // ────────────────────────────────────────────────────────
  // Navigation detection
  // ────────────────────────────────────────────────────────

  function onNavigate() {
    if (isNavigating) return;
    isNavigating = true;
    lastUrl = location.href;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    cleanup();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scannedShadowRoots = new WeakSet(); // reset shadow tracking
        scanAllMedia();
        extractMediaFromPage();
        scheduleScan();
        isNavigating = false;
      });
    });
  }

  function init() {
    setDebug("init");
    scanAllMedia();
    extractMediaFromPage();
    scheduleScan();

    // Observe DOM for new shadow roots appearing
    const shadowObs = new MutationObserver(() => {
      scheduleScan();
    });
    try {
      shadowObs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch { /* ignore */ }

    // History API
    const origPush = history.pushState;
    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return r;
    };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return r;
    };
    window.addEventListener("popstate", () => { if (location.href !== lastUrl) onNavigate(); });

    // Watch for elements with shadow roots appearing via appendChild
    const origAppend = Element.prototype.appendChild;
    Element.prototype.appendChild = function (...args) {
      const result = origAppend.apply(this, args);
      if (result?.shadowRoot) scheduleShadowScan(result.shadowRoot);
      return result;
    };
  }

  // ────────────────────────────────────────────────────────
  // Cleanup
  // ────────────────────────────────────────────────────────

  function cleanup() {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  function buildFilename(ext) {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = Math.max(parts.indexOf("p"), parts.indexOf("reel"), parts.indexOf("tv"), parts.indexOf("reels"), parts.indexOf("stories"));
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

  // ────────────────────────────────────────────────────────
  // Icons
  // ────────────────────────────────────────────────────────

  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="imd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;

  init();
})();
