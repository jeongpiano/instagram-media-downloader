document.addEventListener("DOMContentLoaded", async () => {
  const content = document.getElementById("content");
  const status = document.getElementById("status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("instagram.com")) {
    status.textContent = "Instagram 페이지에서 사용해주세요.";
    return;
  }

  const videoSet = new Set();
  const imageSet = new Set();
  const allThumbnails = {};

  // ── Scan page DOM ──
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

  // ── Supplement from network capture ──
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    (r?.urls || []).forEach((u) => videoSet.add(u));
    (r?.imageUrls || []).forEach((u) => {
      if (!u.includes("/t51.2885-19/") && !u.includes("s150x150")) imageSet.add(u);
    });
    if (r?.thumbnails) Object.assign(allThumbnails, r.thumbnails);
  } catch {}

  // ── GraphQL API fallback ──
  if (videoSet.size === 0) {
    try {
      const postUrl = tab.url.split("?")[0];
      const r = await chrome.runtime.sendMessage({ type: "FETCH_GRAPHQL_MEDIA", postUrl });
      if (r?.url) videoSet.add(r.url);
      // FIX #4: Handle carousel response
      if (r?.carousel) {
        for (const item of r.carousel) {
          if (item.url) {
            if (item.url.includes(".mp4") || item.url.includes("/v/")) videoSet.add(item.url);
            else imageSet.add(item.url);
          }
        }
      }
    } catch {}
  }

  // ── Embed fallback for videos ──
  if (videoSet.size === 0) {
    try {
      const postUrl = tab.url.split("?")[0];
      const r = await chrome.runtime.sendMessage({ type: "FETCH_EMBED_VIDEOS", postUrl });
      (r?.videoUrls || []).forEach((u) => videoSet.add(u));
    } catch {}
  }

  const videos = [...videoSet];
  const images = [...imageSet];
  const total = videos.length + images.length;

  if (total === 0) {
    content.innerHTML = `
      <div class="status">미디어를 찾지 못했습니다.<br><small>로그인 상태여야 할 수 있습니다.</small></div>
      <button class="scan-btn" id="rescan">다시 검색</button>`;
    document.getElementById("rescan")?.addEventListener("click", () => location.reload());
    return;
  }

  const postId = extractPostId(tab.url);
  const pageType = detectPageType(tab.url);
  let html = `<div style="padding:4px 16px 8px;font-size:11px;color:#999;">${pageType} · ${total}개 미디어</div>`;

  if (videos.length) {
    html += `<div class="section-title">Videos (${videos.length})</div>`;
    html += `<ul class="media-list">`;
    videos.forEach((url, i) => {
      const thumb = allThumbnails[url] || null;
      html += mediaItem(url, i, "video", `Video ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  if (images.length) {
    html += `<div class="section-title">Photos (${images.length})</div>`;
    html += `<ul class="media-list">`;
    images.forEach((url, i) => {
      const thumb = allThumbnails[url] || url;
      html += mediaItem(url, videos.length + i, "photo", `Photo ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  html += `
    <div class="dl-all-wrap">
      <button class="dl-all" id="dl-all">모두 다운로드 (${total})</button>
    </div>`;

  content.innerHTML = html;
  setupThumbFallbacks(content);

  const allMedia = [
    ...videos.map((u) => ({ url: u, ext: "mp4", thumb: allThumbnails[u] || null })),
    ...images.map((u) => ({ url: u, ext: "jpg", thumb: allThumbnails[u] || u }))
  ];

  content.querySelectorAll(".dl-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const m = allMedia[idx];
      btn.disabled = true;
      btn.textContent = "...";
      const filename = `instagram/${postId}_${idx + 1}.${m.ext}`;
      const r = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      btn.textContent = r?.ok ? "Done!" : "Failed";
      if (r?.ok) btn.className = "dl-btn done";
      else btn.disabled = false;
    });
  });

  document.getElementById("dl-all")?.addEventListener("click", async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = "다운로드 중...";
    for (let i = 0; i < allMedia.length; i++) {
      const m = allMedia[i];
      const filename = `instagram/${postId}_${i + 1}.${m.ext}`;
      await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      await new Promise((r) => setTimeout(r, 300));
    }
    b.textContent = "완료!";
    b.style.background = "#27ae60";
    content.querySelectorAll(".dl-btn").forEach((btn) => {
      btn.textContent = "Done!";
      btn.className = "dl-btn done";
    });
  });
});

function mediaItem(url, idx, type, label, thumbUrl) {
  const short = shortUrl(url);
  const typeClass = type === "video" ? "type-video" : "type-photo";
  const typeLabel = type === "video" ? "MP4" : "JPG";

  // CSP-safe: no inline event handlers (onerror etc.)
  const videoIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const imageIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const placeholder = `<div class="thumb-placeholder">${type === "video" ? videoIcon : imageIcon}</div>`;

  let thumbHtml;
  if (thumbUrl) {
    if (type === "video") {
      thumbHtml = `<video muted playsinline src="${esc(thumbUrl)}" data-fallback="true"></video>${placeholder}`;
    } else {
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy" data-fallback="true">${placeholder}`;
    }
  } else {
    thumbHtml = placeholder;
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
  try { return new URL(url).pathname.split("/").filter(Boolean).pop()?.slice(0, 35) || "media"; }
  catch { return "media"; }
}

function detectPageType(url) {
  const p = new URL(url).pathname.split("/").filter(Boolean);
  if (p.includes("reel") || p.includes("reels")) return "Reel";
  if (p.includes("p")) return "Post";
  if (p.includes("tv")) return "IGTV";
  if (p.includes("explore")) return "Explore";
  if (p.includes("stories")) return "Story";
  return "Media";
}

// Runs in content script context
function scanPage() {
  const videos = [];
  const images = [];
  const thumbnails = {};

  // SSR JSON scripts
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try { dig(JSON.parse(s.textContent), 0); } catch {}
  }

  // DOM video elements
  for (const v of document.querySelectorAll("video")) {
    const src = v.currentSrc || v.src || "";
    if (src && !src.startsWith("blob:")) {
      videos.push(src);
      if (v.poster) thumbnails[src] = v.poster;
    }
    const source = v.querySelector("source");
    if (source?.src && !source.src.startsWith("blob:")) {
      videos.push(source.src);
      if (v.poster) thumbnails[source.src] = v.poster;
    }
    // FIX: data-videoUrl attribute (new Instagram)
    for (const attr of ["data-videoUrl", "data-video-url", "data-video-src", "data-src"]) {
      const attrVal = v.getAttribute(attr);
      if (attrVal && !attrVal.startsWith("blob:") && (attrVal.includes(".mp4") || attrVal.includes("/v/"))) {
        videos.push(attrVal);
      }
    }
    // Also check dataset
    if (v.dataset) {
      for (const key of Object.keys(v.dataset)) {
        const val = v.dataset[key];
        if (val && !val.startsWith("blob:") && (val.includes(".mp4") || val.includes("/v/"))) {
          videos.push(val);
        }
      }
    }
  }

  // DOM img elements (CDN only, large)
  for (const img of document.querySelectorAll("img")) {
    const src = img.src || "";
    if (!src.includes("cdninstagram.com") && !src.includes("fbcdn.net") && !src.includes("scontent")) continue;
    if (src.includes("/t51.2885-19/")) continue;
    const r = img.getBoundingClientRect();
    if (r.width >= 150 && r.height >= 150) images.push(src);
  }

  return { videos: [...new Set(videos)], images: [...new Set(images)], thumbnails };

  function dig(obj, d) {
    if (d > 30 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      const best = obj.video_versions.reduce((a, b) =>
        (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a,
        obj.video_versions[0]
      );
      if (best?.url) {
        videos.push(best.url);
        // FIX #6: Use image_versions2 for thumbnail, not best.thumbnail_url
        const thumb = obj.image_versions2?.candidates?.[0]?.url || obj.thumbnail_url || null;
        if (thumb) thumbnails[best.url] = thumb;
      }
      return;
    }
    if (typeof obj.video_url === "string") videos.push(obj.video_url);
    if (obj.video_dash_manifest && typeof obj.video_dash_manifest === "string") {
      // Can't parse DASH manifest in popup — handled by background
    }
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      const best = cands[cands.length - 1] || cands[0];
      if (best?.url) {
        images.push(best.url);
        thumbnails[best.url] = best.url;
      }
      return;
    }
    // display_resources (Instagram video posts)
    if (Array.isArray(obj.display_resources)) {
      const best = obj.display_resources[obj.display_resources.length - 1];
      if (best?.src) {
        images.push(best.src);
        thumbnails[best.src] = best.src;
      }
      return;
    }
    if (Array.isArray(obj.carousel_media)) {
      for (const m of obj.carousel_media) dig(m, d + 1);
      return;
    }
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) dig(item, d + 1);
      return;
    }
    if (obj.media) { dig(obj.media, d + 1); return; }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) dig(v, d + 1);
  }
}

function extractPostId(url) {
  const p = new URL(url).pathname.split("/").filter(Boolean);
  const types = ["p", "reel", "tv", "reels", "stories"];
  for (const t of types) {
    const i = p.indexOf(t);
    if (i !== -1 && p[i + 1]) return p[i + 1];
  }
  return "instagram";
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// CSP-safe: handle thumbnail load errors via JS instead of inline onerror
function setupThumbFallbacks(container) {
  for (const el of container.querySelectorAll("[data-fallback]")) {
    el.addEventListener("error", () => {
      el.style.display = "none";
      const next = el.nextElementSibling;
      if (next && next.classList.contains("thumb-placeholder")) {
        next.style.display = "flex";
      }
    });
    // Hide placeholder when media loads successfully
    el.addEventListener("load", () => {
      const next = el.nextElementSibling;
      if (next && next.classList.contains("thumb-placeholder")) {
        next.style.display = "none";
      }
    });
    el.addEventListener("loadeddata", () => {
      const next = el.nextElementSibling;
      if (next && next.classList.contains("thumb-placeholder")) {
        next.style.display = "none";
      }
    });
  }
}
