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

  // Supplement: network-captured URLs + thumbnails
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    (r?.urls || []).forEach((u) => {
      if (u.includes(".mp4") || u.includes("/v/t16/")) videoSet.add(u);
    });
    (r?.imageUrls || []).forEach((u) => {
      if (!u.includes("/t51.2885-19/")) imageSet.add(u);
    });
    if (r?.thumbnails) Object.assign(allThumbnails, r.thumbnails);
  } catch {}

  // Final fallback: embed endpoint (only if nothing found)
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

  // Fix thumbnails: add error handlers via JS (no inline onerror)
  content.querySelectorAll(".media-thumb img").forEach((img) => {
    img.addEventListener("error", () => {
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

// Runs in content script context
function scanPage() {
  const videos = [];
  const images = [];
  const thumbnails = {};

  // SSR JSON
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

    // Fallback: look for sibling/parent img for thumbnail
    if (!thumbnails[src]) {
      const thumbImg = v.closest("[data-image], [data-thumb]")?.querySelector("img")
        || v.parentElement?.querySelector("img[src*='cdninstagram'], img[src*='fbcdn']")
        || v.parentElement?.parentElement?.querySelector("img[src*='cdninstagram'], img[src*='fbcdn']");
      if (thumbImg) {
        const tSrc = thumbImg.src || thumbImg.getAttribute("srcset")?.split(",")?.[0]?.split(" ")?.[0] || "";
        if (tSrc) thumbnails[src] = tSrc;
      }
    }
  }

  // DOM img elements (CDN only, large)
  for (const img of document.querySelectorAll("img")) {
    const src = img.src || "";
    if (!src.includes("cdninstagram.com") && !src.includes("fbcdn.net") && !src.match(/scontent[^.]*\.instagram\.com/)) continue;
    if (src.includes("/t51.2885-19/")) continue;
    const r = img.getBoundingClientRect();
    if (r.width >= 150 && r.height >= 150) images.push(src);
  }

  return { videos: [...new Set(videos)], images: [...new Set(images)], thumbnails };

  function dig(obj, d) {
    if (d > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      for (const v of obj.video_versions) if (v.url) {
        videos.push(v.url);
        if (v.thumbnail_url) thumbnails[v.url] = v.thumbnail_url;
      }
      // Also grab image thumbnail for this video
      if (obj.image_versions2?.candidates?.length) {
        const thumb = obj.image_versions2.candidates[0].url;
        for (const v of obj.video_versions) {
          if (v.url && !thumbnails[v.url]) thumbnails[v.url] = thumb;
        }
      }
      return;
    }
    if (typeof obj.video_url === "string") videos.push(obj.video_url);
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      const best = cands[0] || cands[cands.length - 1];
      if (best?.url) {
        images.push(best.url);
        thumbnails[best.url] = best.url;
      }
      return;
    }
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) dig(m, d + 1);
      return;
    }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) dig(v, d + 1);
  }
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
