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
        out.push({ url: best.url, type: "video", thumb, code: obj.code || null, y: out.length });
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

  // Extract the Instagram post shortcode nearest to a video element.
  function getPostCode(videoEl) {
    // 1. Nearest article link (works when article has a timestamp/permalink <a>)
    const article = videoEl.closest("article");
    if (article) {
      const a = article.querySelector('a[href*="/p/"],a[href*="/reel/"],a[href*="/tv/"]');
      if (a) {
        const am = a.href.match(/\/(p|reel|tv|reels)\/([\w-]+)/);
        if (am) return am[2];
      }
    }

    // 2. URL code — on reels/post pages, Instagram updates the URL to /reel/CODE/
    //    via pushState. This is the most reliable source for the currently-visible video.
    const urlMatch = location.pathname.match(/\/(p|reel|tv)\/([\w-]+)/);
    if (urlMatch) {
      const urlCode = urlMatch[2];
      const allVideos = [...document.querySelectorAll("video")];
      if (allVideos.length <= 1) return urlCode;
      // Multiple videos: URL code belongs to the most-visible one
      const vh = window.innerHeight;
      const vr = videoEl.getBoundingClientRect();
      const visibleH = Math.max(0, Math.min(vr.bottom, vh) - Math.max(vr.top, 0));
      const totalH = vr.height || 1;
      if (visibleH / totalH > 0.3) return urlCode; // >30% visible → it's the current reel
    }

    // 3. SSR JSON — parse the JSON tree to find objects where "code" and "video_versions"
    //    are siblings. IMPORTANT: SSR data is from the initial page load, so it becomes
    //    stale after the user scrolls to dynamically-loaded content.
    const ssrEntries = []; // [{code, url}]
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const items = [];
        findMediaUrls(JSON.parse(s.textContent), items, 0);
        for (const item of items) {
          if (item.type === "video" && item.code) ssrEntries.push({ code: item.code, url: item.url });
        }
      } catch {}
    }
    // Validate freshness: if URL has a code not in SSR, the SSR data is stale
    if (urlMatch && ssrEntries.length > 0 && !ssrEntries.some(e => e.code === urlMatch[2])) {
      return ""; // SSR stale — no reliable code for this video
    }
    if (ssrEntries.length === 1) return ssrEntries[0].code;
    if (ssrEntries.length > 1) {
      const allVideos = [...document.querySelectorAll("video")];
      const vIdx = allVideos.indexOf(videoEl);
      if (vIdx >= 0 && vIdx < ssrEntries.length) return ssrEntries[vIdx].code;
      const allArticles = [...document.querySelectorAll("article")];
      const aIdx = allArticles.indexOf(videoEl.closest("article"));
      if (aIdx >= 0 && aIdx < ssrEntries.length) return ssrEntries[aIdx].code;
      // DO NOT fallback to ssrEntries[0] — that would assign the first video's code
      // to ALL unmatched videos, causing them to download the wrong video.
      return "";
    }

    // 4. Page URL — fallback for single-post pages
    if (urlMatch) return urlMatch[2];
    return "";
  }

  // Get SSR JSON entries {code, url} for all videos on the page (cached per scan cycle)
  let _ssrCache = null;
  function getSsrVideoEntries() {
    if (_ssrCache) return _ssrCache;
    const entries = [];
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const items = [];
        findMediaUrls(JSON.parse(s.textContent), items, 0);
        for (const item of items) {
          if (item.type === "video" && item.url) {
            entries.push({ code: item.code || "", url: item.url });
          }
        }
      } catch {}
    }
    _ssrCache = entries;
    return entries;
  }

  function scan() {
    _ssrCache = null; // invalidate SSR cache each scan cycle

    // Videos
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      // Clear stale data from previous navigation (Instagram reuses <video> elements)
      delete video.dataset.imdCode;
      delete video.dataset.imdVideoUrl;
      delete video.dataset.imdSsrUrl;
      // Store shortcode AND direct CDN URL from SSR JSON
      const code = getPostCode(video);
      if (code) video.dataset.imdCode = code;
      // Also store the SSR CDN URL directly on the element (most reliable for download)
      const ssrEntries = getSsrVideoEntries();
      const allVideos = [...document.querySelectorAll("video")];
      const vIdx = allVideos.indexOf(video);
      if (vIdx >= 0 && vIdx < ssrEntries.length && ssrEntries[vIdx].url) {
        video.dataset.imdSsrUrl = ssrEntries[vIdx].url;
      }
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
      if (!container || container.querySelector(`.${WRAP_CLASS}`)) continue;
      attachOverlay(container, img, "image");
    }

    // ── Carousel "All" button — add to EVERY wrap inside carousel articles ──
    for (const article of document.querySelectorAll("article")) {
      if (!isCarouselArticle(article)) continue;
      article.setAttribute("data-imd-all", "1");
      // Add "All" to every image wrap in this article (covers all slides)
      for (const wrap of article.querySelectorAll(`.${WRAP_CLASS}`)) {
        addCarouselAllBtn(wrap, article);
      }
    }
  }

  // Returns true when the article has multiple slides (carousel)
  function isCarouselArticle(article) {
    // 1. Next-slide button is present from slide 1 whenever there are ≥2 photos
    if (article.querySelector('button[aria-label="Next"], button[aria-label="다음"]')) return true;
    // 2. Position-based: SVG button near the right edge of the article
    const ar = article.getBoundingClientRect();
    for (const btn of article.querySelectorAll("button")) {
      if (!btn.querySelector("svg")) continue;
      const br = btn.getBoundingClientRect();
      if (br.width > 0 && br.width < 60 && br.left > ar.right - 80) return true;
    }
    // 3. 1/N counter (appears after user swipes at least once)
    for (const el of article.querySelectorAll("*")) {
      if (el.children.length === 0 && /^\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/.test(el.textContent)) return true;
    }
    return false;
  }

  // Append the "All" button to an existing wrap (only once per wrap)
  function addCarouselAllBtn(wrap, article) {
    if (wrap.querySelector(".imd-all-btn")) return; // already added
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = BTN_CLASS + " imd-all-btn";
    allBtn.style.cssText = "background:rgba(39,174,96,0.9);margin-left:6px;";
    allBtn.innerHTML = `${ICON_IMG_DL}<span>All</span>`;
    allBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      downloadAllCarousel(article, allBtn);
    });
    wrap.appendChild(allBtn);
  }

  // Auto-advance carousel and download all photos
  async function downloadAllCarousel(article, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>스캔...</span>`;

    const allUrls = new Set();

    function collectCurrentSlideImages() {
      for (const img of article.querySelectorAll("img")) {
        const srcset = img.getAttribute("srcset") || "";
        let best = "";
        if (srcset) {
          const cands = srcset.split(",").map(s => {
            const p = s.trim().split(/\s+/);
            return { url: p[0], w: parseInt(p[1]) || 0 };
          }).filter(c => CDN_PATTERN.test(c.url) && !c.url.includes("t51.2885-19") && !c.url.includes("s150x150"));
          if (cands.length) { cands.sort((a, b) => b.w - a.w); best = cands[0].url; }
        }
        if (!best) best = img.src || img.currentSrc || "";
        if (!CDN_PATTERN.test(best) || best.includes("t51.2885-19") || best.includes("s150x150")) continue;
        const r = img.getBoundingClientRect();
        if ((r.width || img.naturalWidth || 0) < 150) continue;
        allUrls.add(best);
      }
    }

    function findSlideBtn(next) {
      const nextLabels = ["Next", "다음", "Siguiente", "Weiter", "Suivant", "次へ", "下一张", "Avanti"];
      const prevLabels = ["돌아가기", "Go back", "이전", "Anterior", "Zurück", "Précédent", "前へ", "上一张", "Indietro"];
      for (const label of (next ? nextLabels : prevLabels)) {
        const b = article.querySelector(`button[aria-label="${label}"]`);
        if (b) return b;
      }
      // Position-based fallback: SVG button at right (next) or left (prev) edge of article
      const ar = article.getBoundingClientRect();
      for (const b of article.querySelectorAll("button")) {
        if (!b.querySelector("svg")) continue;
        const br = b.getBoundingClientRect();
        if (next  && br.left > ar.right - 90 && br.width < 60) return b;
        if (!next && br.right < ar.left + 90 && br.width < 60) return b;
      }
      return null;
    }

    // Go to first slide
    let pb;
    for (let i = 0; i < 20 && (pb = findSlideBtn(false)); i++) {
      pb.click();
      await new Promise(r => setTimeout(r, 350));
    }

    // Advance through all slides, collecting images
    collectCurrentSlideImages();
    let nb;
    for (let i = 0; i < 30 && (nb = findSlideBtn(true)); i++) {
      nb.click();
      await waitForNewSlide(article, 700);
      collectCurrentSlideImages();
    }

    const urls = [...allUrls];
    if (!urls.length) { showStatus(btn, prev, "사진 없음", 2000); return; }

    // Get post shortcode for filename
    const aLink = article.querySelector('a[href*="/p/"],a[href*="/reel/"]');
    const code = aLink?.href.match(/\/(p|reel)\/([\w-]+)/)?.[2]
      || location.pathname.match(/\/(p|reel)\/([\w-]+)/)?.[2]
      || Date.now().toString();

    for (let i = 0; i < urls.length; i++) {
      btn.innerHTML = `<span>${i + 1}/${urls.length}</span>`;
      await sendMsg({ type: "DOWNLOAD_MEDIA", url: urls[i], filename: `instagram/${code}_${i + 1}.jpg` });
      await new Promise(r => setTimeout(r, 200));
    }
    showStatus(btn, prev, `${ICON_CHECK}<span>완료 (${urls.length}장)</span>`, 5000);
  }

  // Wait until a new image appears in the article (or timeout)
  function waitForNewSlide(article, timeout) {
    return new Promise(resolve => {
      const key = () => [...article.querySelectorAll("img")].map(i => i.src + (i.currentSrc || "")).join("|");
      const initial = key();
      const mo = new MutationObserver(() => { if (key() !== initial) { mo.disconnect(); resolve(); } });
      mo.observe(article, { subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
      setTimeout(() => { mo.disconnect(); resolve(); }, timeout);
    });
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

    // For videos: capture CDN URL at the moment the video starts playing
    if (isVideo) {
      const storeCapturedUrl = () => {
        const playTime = Date.now();
        setTimeout(async () => {
          const c = await sendMsg({ type: "GET_CAPTURED_URLS" });
          // Use timestamp proximity: pick the full video URL captured closest to this play event
          const entries = (c?.urlEntries || []).filter(e =>
            !e.url.includes("bytestart") && !e.url.includes("-seg-") && !e.url.includes("/range/")
          );
          if (entries.length) {
            entries.sort((a, b) => Math.abs(a.ts - playTime) - Math.abs(b.ts - playTime));
            mediaEl.dataset.imdVideoUrl = entries[0].url;
            return;
          }
          // Fallback: strip range params from captured URLs (Instagram uses bytestart/byteend
          // for DASH/MSE streaming, but the base URL without range params downloads the full video)
          const allEntries = (c?.urlEntries || []).filter(e =>
            (e.url.includes("cdninstagram") || e.url.includes("fbcdn")) &&
            !e.url.includes("-seg-")
          );
          if (allEntries.length) {
            allEntries.sort((a, b) => Math.abs(a.ts - playTime) - Math.abs(b.ts - playTime));
            const baseUrl = allEntries[0].url
              .replace(/[&?](bytestart|byteend)=[^&]*/g, "")
              .replace(/[?&]$/, "");
            mediaEl.dataset.imdVideoUrl = baseUrl;
            return;
          }
          // Last fallback: last captured full URL
          const full = (c?.urls || []).filter(u =>
            !u.includes("bytestart") && !u.includes("-seg-") && !u.includes("/range/")
          );
          if (full.length) mediaEl.dataset.imdVideoUrl = full[full.length - 1];
        }, 400); // brief wait for webRequest to record the URL
      };
      // Use { once: true } — fires once when video first plays; MutationObserver below handles src changes
      mediaEl.addEventListener("play",        storeCapturedUrl, { once: true });
      mediaEl.addEventListener("loadeddata",  storeCapturedUrl, { once: true });
      // If video is already playing/loaded (scan ran after autoplay), capture now
      if (!mediaEl.paused || mediaEl.readyState >= 2) {
        storeCapturedUrl();
      }

      // Watch for non-blob src changes
      const srcObs = new MutationObserver(() => {
        const s = mediaEl.currentSrc || mediaEl.src || "";
        if (s && !s.startsWith("blob:")) {
          mediaEl.dataset.imdVideoUrl = s;
          try { chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls: [s] }); } catch (_) {}
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

      // Re-derive the shortcode at download time (scan-time code may be stale).
      const freshCode = getPostCode(video);
      const code = freshCode || video.dataset.imdCode || "";
      if (freshCode) video.dataset.imdCode = freshCode;

      // ── Strategy 1: SSR JSON direct CDN URL (stored at scan time per-video) ──
      // This is the most reliable: index-matched to this specific video element,
      // no network roundtrip, no code needed.
      if (video.dataset.imdSsrUrl) {
        url = video.dataset.imdSsrUrl;
      }

      // ── Strategy 2: CDN URL captured when this video played ──
      if (!url && video.dataset.imdVideoUrl) {
        url = video.dataset.imdVideoUrl;
      }

      // ── Strategy 3: non-blob src on the video element ──
      if (!url) url = getNonBlobSrc(video);

      // ── Strategy 4: embed endpoint via shortcode ──
      if (!url && code) {
        for (const t of ["reel", "p", "tv"]) {
          const embed = await sendMsg({
            type: "FETCH_EMBED_VIDEOS",
            postUrl: `https://www.instagram.com/${t}/${code}/`
          });
          if (embed?.videoUrls?.length) { url = embed.videoUrls[0]; break; }
        }
      }

      // ── Strategy 5: SSR JSON by video index (fresh parse) ──
      if (!url) url = findVideoUrlFromScriptsNear(video);

      // ── Strategy 6: data attributes on parent elements ──
      if (!url) url = findVideoUrlInPost(video);

      // ── Strategy 7: network-captured URLs (last resort) ──
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const capturedUrls = captured?.urls || [];
        const full = capturedUrls.filter(u =>
          !u.includes("bytestart") && !u.includes("byteend") &&
          !u.includes("-seg-") && !u.includes("/range/")
        );
        if (full.length) {
          url = full[full.length - 1];
        } else {
          // Strip range params
          const withRange = capturedUrls.filter(u =>
            u.includes("cdninstagram") || u.includes("fbcdn")
          );
          if (withRange.length) {
            url = withRange[withRange.length - 1]
              .replace(/[&?](bytestart|byteend)=[^&]*/g, "")
              .replace(/[?&]$/, "");
          }
        }
      }

      // ── Strategy 8: embed from current page URL ──
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
        if (embed?.videoUrls?.length) url = embed.videoUrls[0];
      }

      if (!url) {
        showStatus(btn, prev, "No video found", 2500);
        return;
      }

      // Use code in filename so user can tell downloads apart
      const postId = code || location.pathname.match(/\/(p|reel|tv|reels)\/([\w-]+)/)?.[2] || "instagram";
      const filename = `instagram/${postId}_${Date.now()}.mp4`;
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      if (resp?.ok) {
        showStatus(btn, prev, `${ICON_CHECK}<span>Saved!</span>`, 2500);
      } else {
        showStatus(btn, prev, "<span>Failed</span>", 2500);
      }
    } catch (err) {
      console.error("[IMD] downloadVideo error:", err);
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

  // ── Find video URL from SSR JSON scripts, matched to the specific video element ──
  function findVideoUrlFromScriptsNear(video) {
    // Collect ALL unique video URLs from ALL SSR JSON scripts on the page
    const allSsrVideoUrls = [];
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const items = [];
        findMediaUrls(JSON.parse(script.textContent), items, 0);
        for (const item of items) {
          if (item.type === "video" && item.url && !allSsrVideoUrls.includes(item.url)) {
            allSsrVideoUrls.push(item.url);
          }
        }
      } catch {}
    }

    if (!allSsrVideoUrls.length) return "";
    if (allSsrVideoUrls.length === 1) return allSsrVideoUrls[0];

    // Match by article position (most reliable for feeds with multiple video posts)
    const allArticles = Array.from(document.querySelectorAll("article"));
    const closestArticle = video.closest("article");
    if (closestArticle && allArticles.length > 0) {
      const articleIdx = allArticles.indexOf(closestArticle);
      if (articleIdx >= 0 && articleIdx < allSsrVideoUrls.length) {
        return allSsrVideoUrls[articleIdx];
      }
    }

    // No articles (reels page, stories, etc.) — match by video element index
    const allVideos = Array.from(document.querySelectorAll("video"));
    const videoIdx = allVideos.indexOf(video);
    if (videoIdx >= 0 && videoIdx < allSsrVideoUrls.length) {
      return allSsrVideoUrls[videoIdx];
    }
    // No confident match — return "" so download() uses other strategies
    // (DO NOT fallback to allSsrVideoUrls[0] — that always returns the first video)
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
