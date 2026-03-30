/*
 * Content script - Instagram Media Downloader v4.1
 * Fixed: lazy image detection, stacking context, DOM replacement,
 * story URLs, hover race condition
 */
(() => {
  "use strict";

  const PROCESSED = "data-imd";
  const WRAP_CLASS = "imd-wrap";
  const BTN_CLASS = "imd-btn";
  const VISIBLE_CLASS = "imd-visible";

  const CDN_PATTERN = /cdninstagram\.com|fbcdn\.net|scontent.*\.instagram\.com/i;

  let lastUrl = location.href;
  let scanTimer = null;
  let isNavigating = false;

  // ── DEBUG bar ──
  const dbg = document.createElement("div");
  dbg.id = "imd-debug";
  Object.assign(dbg.style, {
    position: "fixed", top: "0", left: "0", zIndex: "2147483647",
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

    // MutationObserver for React re-renders — also re-check processed markers
    const obs = new MutationObserver((mutations) => {
      if (location.href !== lastUrl) onNavigate();
      // Check if processed elements were removed by React
      revalidateProcessed();
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // History API: SPA navigation
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return r;
    };
    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return r;
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

  // FIX #3: Re-validate processed markers — React may replace DOM nodes
  function revalidateProcessed() {
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => {
      // If the overlay wrapper was removed by React, re-mark for scanning
      const wrap = el.closest ? el.querySelector(`.${WRAP_CLASS}`) : null;
      if (el.hasAttribute(PROCESSED) && !el.parentElement?.querySelector(`.${WRAP_CLASS}`) && !el.querySelector(`.${WRAP_CLASS}`)) {
        el.removeAttribute(PROCESSED);
      }
    });
  }

  // ────────────────────────────────────────────────────────
  // SSR JSON extraction
  // ────────────────────────────────────────────────────────

  function extractMediaFromPage() {
    const media = [];
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        digMedia(JSON.parse(script.textContent), media, 0);
      } catch { /* skip */ }
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
    if (depth > 30 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { for (const v of obj) digMedia(v, out, depth + 1); return; }

    // video_versions array
    if (Array.isArray(obj.video_versions) && obj.video_versions.length) {
      const best = obj.video_versions.reduce((a, b) =>
        (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a,
        obj.video_versions[0]
      );
      if (best?.url) {
        const thumb = obj.image_versions2?.candidates?.[0]?.url || obj.thumbnail_url || obj.display_url || null;
        out.push({ url: best.url, type: "video", thumb, y: out.length });
      }
      return;
    }
    if (typeof obj.video_url === "string" && obj.video_url) {
      out.push({ url: obj.video_url, type: "video", thumb: obj.thumbnail_url || obj.display_url || null, y: out.length });
      return;
    }
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        const best = cands.reduce((a, b) =>
          (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a,
          cands[0]
        );
        if (best?.url) out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
      }
      return;
    }
    if (obj.display_resources) {
      const best = obj.display_resources[obj.display_resources.length - 1];
      if (best?.src) out.push({ url: best.src, type: "image", thumb: best.src, y: out.length });
      return;
    }
    if (typeof obj.display_url === "string" && obj.display_url && CDN_PATTERN.test(obj.display_url)) {
      out.push({ url: obj.display_url, type: "image", thumb: obj.display_url, y: out.length });
      return;
    }
    if (Array.isArray(obj.carousel_media)) {
      for (const m of obj.carousel_media) digMedia(m, out, depth + 1);
      return;
    }
    if (Array.isArray(obj.reel_media)) {
      for (const m of obj.reel_media) digMedia(m, out, depth + 1);
      return;
    }
    if (Array.isArray(obj.stories)) {
      for (const m of obj.stories) digMedia(m, out, depth + 1);
      return;
    }

    for (const k of Object.keys(obj)) digMedia(obj[k], out, depth + 1);
  }

  // ────────────────────────────────────────────────────────
  // DOM scan
  // ────────────────────────────────────────────────────────

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 800);
  }

  function scan() {
    const vCount = document.querySelectorAll("video").length;
    const iCount = document.querySelectorAll("img").length;
    setDebug(`scan v:${vCount} i:${iCount}`);

    // Videos
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findContainer(video, true);
      if (container) attachOverlay(container, video, "video");
    }

    // Images
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      if (src.includes("/t51.2885-19/")) continue;
      if (src.includes("s150x150")) continue;

      // FIX #1: Don't skip lazy images that haven't entered viewport yet
      // Use naturalWidth/naturalHeight as backup (works even for offscreen images)
      const rect = img.getBoundingClientRect();
      const w = rect.width || img.naturalWidth || 0;
      const h = rect.height || img.naturalHeight || 0;
      if (w < 100 && h < 100) continue;

      img.setAttribute(PROCESSED, "image");
      const container = findContainer(img, false);
      if (container) attachOverlay(container, img, "image");
    }
  }

  function findContainer(el, isVideo) {
    if (isVideo) return el;
    // Walk up to find Instagram's post media container
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect();
      // Use naturalWidth as fallback for offscreen
      const w = r.width || 0;
      const h = r.height || 0;
      if (w >= 150 && h >= 150) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  // ────────────────────────────────────────────────────────
  // Overlay
  // ────────────────────────────────────────────────────────

  function attachOverlay(container, mediaEl, mediaType) {
    const isVideo = mediaType === "video";

    if (isVideo) {
      if (getComputedStyle(mediaEl).position === "static") {
        mediaEl.style.position = "relative";
      }
    } else {
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
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
      if (isVideo) downloadVideo(mediaEl, btn);
      else downloadImage(mediaEl, btn);
    });

    wrap.appendChild(btn);
    container.appendChild(wrap);

    // FIX #10: Hover — use a flag instead of setTimeout race
    let hoverCount = 0;
    const show = () => { hoverCount++; wrap.classList.add(VISIBLE_CLASS); };
    const hide = () => {
      hoverCount--;
      setTimeout(() => {
        if (hoverCount <= 0) {
          hoverCount = 0;
          wrap.classList.remove(VISIBLE_CLASS);
        }
      }, 300);
    };
    mediaEl.addEventListener("mouseenter", show);
    mediaEl.addEventListener("mouseleave", hide);
    wrap.addEventListener("mouseenter", show);
    wrap.addEventListener("mouseleave", hide);
    // Also show on container hover (for images where container != mediaEl)
    if (container !== mediaEl) {
      container.addEventListener("mouseenter", show);
      container.addEventListener("mouseleave", hide);
    }

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

  // ────────────────────────────────────────────────────────
  // Downloads
  // ────────────────────────────────────────────────────────

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

  async function downloadVideo(video, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    try {
      let url = "";

      // Strategy 1: direct video src
      url = getNonBlobSrc(video);

      // Strategy 2: walk up DOM for data attributes
      if (!url) url = findVideoUrlInPost(video);

      // Strategy 3: SSR JSON scripts near this video
      if (!url) url = findVideoUrlFromScriptsNear(video);

      // Strategy 4: network-captured CDN URLs
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const urls = captured?.urls || [];
        if (urls.length) url = urls[urls.length - 1];
      }

      // Strategy 5: GraphQL API
      if (!url) {
        const postUrl = findPostUrl();
        if (postUrl) {
          const gql = await sendMsg({ type: "FETCH_GRAPHQL_MEDIA", postUrl });
          if (gql?.url) url = gql.url;
        }
      }

      // Strategy 6: embed fallback
      if (!url) {
        const postUrl = findPostUrl();
        if (postUrl) {
          const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
          if (embed?.videoUrls?.length) url = embed.videoUrls[0];
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

  function findVideoUrlInPost(video) {
    let node = video;
    for (let i = 0; i < 15 && node; i++) {
      for (const attr of ["data-videoUrl", "data-video-url", "data-src", "data-url", "data-video-src"]) {
        const v = node.getAttribute?.(attr);
        if (v && !v.startsWith("blob:") && (v.includes(".mp4") || v.includes("/v/") || v.includes(".m3u8"))) {
          return v;
        }
      }
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

  // FIX from threads-ref: add id pattern stop condition like Threads
  function findVideoUrlFromScriptsNear(video) {
    let postNode = video;
    for (let i = 0; i < 10 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" ||
          (postNode.getAttribute?.("role") === "presentation") ||
          (postNode.id && /post|thread|item|entry|media/i.test(postNode.id))) {
        break;
      }
      postNode = postNode.parentElement;
    }
    if (!postNode) return "";
    const scripts = postNode.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const urls = [];
        digMedia(JSON.parse(script.textContent), urls, 0);
        for (const item of urls) {
          if (item.type === "video" && item.url) return item.url;
        }
      } catch {}
    }
    return "";
  }

  // FIX #9: match stories URLs too
  function findPostUrl() {
    const href = location.href;
    if (/\/(p|reel|tv|reels)\/[\w-]+/.test(href)) return href.split("?")[0];
    if (/\/stories\/[\w.]+\/\d+/.test(href)) return href.split("?")[0];
    return "";
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  function buildFilename(ext) {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = Math.max(
      parts.indexOf("p"), parts.indexOf("reel"),
      parts.indexOf("tv"), parts.indexOf("reels"),
      parts.indexOf("stories")
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

  // ────────────────────────────────────────────────────────
  // Icons
  // ────────────────────────────────────────────────────────

  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="imd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
})();
