(() => {
  "use strict";

  const PROCESSED = "data-imd";
  const WRAP_CLASS = "imd-wrap";
  const BTN_CLASS = "imd-btn";
  const VISIBLE_CLASS = "imd-visible";

  // CDN domains used by Instagram
  const CDN_PATTERN = /cdninstagram\.com|fbcdn\.net|scontent[^.]*\.instagram\.com/;

  // Instagram post URL patterns
  const POST_PATTERN = /\/(p|reel|tv|reels|stories)\//;

  let lastUrl = location.href;
  let scanTimer = null;
  let isNavigating = false;

  init();

  function init() {
    extractVideoUrlsFromScripts();
    scheduleScan();

    // MutationObserver: DOM structure changes (covers React/Virtual DOM re-renders)
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        onNavigate();
      }
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // History API: SPA navigation (pushState / replaceState)
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

    // popstate: back/forward navigation
    window.addEventListener("popstate", () => {
      if (location.href !== lastUrl) onNavigate();
    });

    // Re-scan on scroll for lazy-loaded content (infinite scroll)
    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => { scrollTimer = null; scheduleScan(); }, 500);
    }, { passive: true });
  }

  function onNavigate() {
    if (isNavigating) return;
    isNavigating = true;
    lastUrl = location.href;

    // Cancel any pending scan so cleanup + fresh scan run cleanly
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }

    cleanup();

    // Wait for React to finish rendering before extracting/scanning
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        extractVideoUrlsFromScripts();
        scheduleScan();
        isNavigating = false;
      });
    });
  }

  // ── SSR JSON parsing (video_versions / image_versions2) ──
  function extractVideoUrlsFromScripts() {
    const media = []; // { url, type, thumb, y }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        findMediaUrls(JSON.parse(script.textContent), media, 0);
      } catch { /* skip */ }
    }
    if (media.length) {
      // Sort by viewport position (top to bottom)
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try { chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails }); } catch (_) {}
    }
  }

  function findMediaUrls(obj, out, depth) {
    if (depth > 20 || !obj || typeof obj !== "object") return;
    // video
    if (Array.isArray(obj.video_versions)) {
      // Pick highest quality video (first entry is usually highest)
      const best = obj.video_versions[0];
      if (best?.url) {
        // Try to get thumbnail from image_versions2
        let thumb = null;
        if (obj.image_versions2?.candidates?.length) {
          thumb = obj.image_versions2.candidates[0].url;
        }
        out.push({ url: best.url, type: "video", thumb, y: out.length });
      }
      return;
    }
    if (typeof obj.video_url === "string") {
      out.push({ url: obj.video_url, type: "video", thumb: null, y: out.length });
    }
    // image — collect highest quality candidate
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        // First candidate is typically highest resolution
        const best = cands[0];
        if (best.url) {
          out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
        }
      }
      return;
    }
    // Carousel: nested media array
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) findMediaUrls(m, out, depth + 1);
      return;
    }
    for (const val of (Array.isArray(obj) ? obj : Object.values(obj))) {
      findMediaUrls(val, out, depth + 1);
    }
  }

  // ── DOM scan: attach buttons on images & videos ──
  function scheduleScan() {
    if (scanTimer) {
      clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 800);
  }

  function scan() {
    // Videos — button goes on the video element itself
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findContainer(video, true);
      if (container && !container.querySelector(`.${WRAP_CLASS}`)) attachOverlay(container, video, "video");
    }

    // Images – only large CDN images (skip avatars, icons)
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = getCdnUrl(img);
      if (!src) continue;
      // Skip profile pictures path
      if (src.includes("/t51.2885-19/")) continue;
      // Skip small images — use naturalWidth/Height as fallback for lazy-loaded
      const rect = img.getBoundingClientRect();
      const w = rect.width || img.naturalWidth || parseInt(img.getAttribute("width")) || 0;
      const h = rect.height || img.naturalHeight || parseInt(img.getAttribute("height")) || 0;
      if (w < 150 || h < 150) continue;

      img.setAttribute(PROCESSED, "image");
      const container = findContainer(img, false);
      if (container && !container.querySelector(`.${WRAP_CLASS}`)) attachOverlay(container, img, "image");
    }
  }

  function findContainer(el, isVideo) {
    // Walk up from the element to find a suitable container
    // (Never use <video> or <img> itself — they cannot have visible children)
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 150) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  // Extract CDN URL from img src or srcset
  function getCdnUrl(img) {
    const src = img.src || img.currentSrc || "";
    if (src && CDN_PATTERN.test(src)) return src;
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        if (CDN_PATTERN.test(url)) return url;
      }
    }
    return "";
  }

  // ── Overlay button with JS-based hover ──
  function attachOverlay(container, mediaEl, mediaType) {
    const isVideo = mediaType === "video";

    // Make container positionable (container is always a parent div, never <video>/<img>)
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    // Add class for CSS-based hover (more reliable than JS events with Instagram overlays)
    container.classList.add("imd-hover-parent");

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

    // JS-based hover: listen on the container (not mediaEl) to handle Instagram overlays
    const show = () => wrap.classList.add(VISIBLE_CLASS);
    const hide = () => {
      setTimeout(() => {
        if (!wrap.matches(":hover") && !container.matches(":hover")) {
          wrap.classList.remove(VISIBLE_CLASS);
        }
      }, 200);
    };

    container.addEventListener("mouseenter", show);
    container.addEventListener("mouseleave", hide);
    wrap.addEventListener("mouseenter", show);
    wrap.addEventListener("mouseleave", hide);

    // Also watch for src changes on video
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
      srcObs.observe(mediaEl, { attributes: true, attributeFilter: ["src"] });
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
    // Check srcset for highest resolution
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const candidates = srcset.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        const w = parseInt(parts[1]) || 0;
        return { url: parts[0], w };
      });
      candidates.sort((a, b) => b.w - a.w);
      if (candidates[0]?.url) return candidates[0].url;
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

      // Strategy 1: video element's non-blob src
      url = getNonBlobSrc(video);

      // Strategy 2: look in parent article/post data
      if (!url) {
        url = findVideoUrlInPost(video);
      }

      // Strategy 3: from SSR JSON scripts near this video
      if (!url) {
        url = findVideoUrlFromScriptsNear(video);
      }

      // Strategy 4: network-captured CDN URLs (prefer full videos, not DASH segments)
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const capturedUrls = captured?.urls || [];
        if (capturedUrls.length) {
          // Prefer URLs that look like full video files (not DASH/HLS segments)
          const fullUrls = capturedUrls.filter(u =>
            !u.includes("bytestart") && !u.includes("byteend") &&
            !u.includes("-seg-") && !u.includes("/range/")
          );
          url = fullUrls.length ? fullUrls[0] : capturedUrls[0];
        }
      }

      // Strategy 5: embed endpoint fallback
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

  // ── Find video URL from parent article/post element ──
  function findVideoUrlInPost(video) {
    let node = video;
    for (let i = 0; i < 10 && node; i++) {
      const url = node.dataset?.videoUrl || node.dataset?.video_url;
      if (url && !url.startsWith("blob:") && (url.includes(".mp4") || url.includes("/v/"))) {
        return url;
      }
      node = node.parentElement;
    }
    return "";
  }

  // ── Find video URL from SSR JSON scripts ──
  function findVideoUrlFromScriptsNear(video) {
    // First: try scripts near the video (within article/section)
    let postNode = video;
    for (let i = 0; i < 10 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" ||
          (postNode.id && /post|thread|item|entry/i.test(postNode.id))) {
        break;
      }
      postNode = postNode.parentElement;
    }
    if (postNode) {
      const scripts = postNode.querySelectorAll ? postNode.querySelectorAll('script[type="application/json"]') : [];
      for (const script of scripts) {
        try {
          const urls = [];
          findMediaUrls(JSON.parse(script.textContent), urls, 0);
          for (const item of urls) {
            if (item.type === "video" && item.url) return item.url;
          }
        } catch {}
      }
    }

    // Fallback: search ALL script tags on the page (SSR JSON is often in <head>, not in <article>)
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const urls = [];
        findMediaUrls(JSON.parse(script.textContent), urls, 0);
        for (const item of urls) {
          if (item.type === "video" && item.url) return item.url;
        }
      } catch {}
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

  // ── Helpers ──
  function buildFilename(ext) {
    const parts = location.pathname.split("/").filter(Boolean);
    // Instagram post patterns: /p/CODE/, /reel/CODE/, /tv/CODE/, /reels/CODE/, /stories/USER/ID/
    const postTypes = ["p", "reel", "tv", "reels", "stories"];
    let postId = "instagram";
    for (let i = 0; i < parts.length; i++) {
      if (postTypes.includes(parts[i]) && parts[i + 1]) {
        postId = parts[i + 1];
        break;
      }
    }
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
