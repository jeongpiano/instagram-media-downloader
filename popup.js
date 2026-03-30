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
    }
  } catch (e) {
    status.textContent = "페이지 스캔 실패. 새로고침 후 다시 시도해주세요.";
    return;
  }

  // Supplement: only merge thumbnails from background (don't add ALL captured URLs — viewport filter handles selection)
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    if (r?.thumbnails) Object.assign(allThumbnails, r.thumbnails);
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
    html += `<div class="section-title">Photos (${images.length})</div>`;
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

// Runs in content script context — only returns media visible in current viewport
function scanPage() {
  const videos = [];
  const images = [];
  const thumbnails = {};
  const vh = window.innerHeight;
  const cdnRe = /cdninstagram\.com|fbcdn\.net|scontent[^.]*\.instagram\.com/;

  // ── Step 1: Extract ALL video/image URLs from SSR JSON (for matching blob: videos) ──
  const ssrVideos = []; // { url, thumb }
  const ssrImages = []; // { url }
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try { digSSR(JSON.parse(s.textContent), 0); } catch {}
  }

  function digSSR(obj, d) {
    if (d > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      const best = obj.video_versions[0];
      if (best?.url) {
        let thumb = null;
        if (obj.image_versions2?.candidates?.length) {
          thumb = obj.image_versions2.candidates[0].url;
        }
        ssrVideos.push({ url: best.url, thumb });
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

    // Non-blob source
    if (src && !src.startsWith("blob:")) {
      videos.push(src);
      if (thumb) thumbnails[src] = thumb;
    } else if (sourceSrc && !sourceSrc.startsWith("blob:")) {
      videos.push(sourceSrc);
      if (thumb) thumbnails[sourceSrc] = thumb;
      src = sourceSrc;
    } else {
      // blob: video — match to SSR JSON URL by order
      if (ssrVideoIdx < ssrVideos.length) {
        const ssr = ssrVideos[ssrVideoIdx];
        videos.push(ssr.url);
        src = ssr.url;
        if (ssr.thumb) thumb = ssr.thumb;
        ssrVideoIdx++;
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

  // ── Step 3: Scan DOM images in viewport ──
  for (const img of document.querySelectorAll("img")) {
    const r = img.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh) continue; // Not in viewport

    let src = img.src || img.currentSrc || "";
    if (!cdnRe.test(src)) {
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        for (const part of srcset.split(",")) {
          const url = part.trim().split(/\s+/)[0];
          if (cdnRe.test(url)) { src = url; break; }
        }
      }
    }
    if (!cdnRe.test(src)) continue;
    if (src.includes("/t51.2885-19/")) continue;
    const w = r.width || img.naturalWidth || parseInt(img.getAttribute("width")) || 0;
    const h = r.height || img.naturalHeight || parseInt(img.getAttribute("height")) || 0;
    if (w >= 150 && h >= 150) {
      images.push(src);
      thumbnails[src] = src;
    }
  }

  return { videos: [...new Set(videos)], images: [...new Set(images)], thumbnails };
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
