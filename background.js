/*
 * Background service worker - Instagram Media Downloader v1
 * - Captures CDN URLs from webRequest
 * - declarativeNetRequest: auto-injects Referer header for CDN requests
 * - Downloads via chrome.downloads
 */

const capturedMedia = new Map(); // tabId -> { videos: Map<url,ts>, images: Map<url,ts>, thumbnails: {} }

// ── Network request interception ──
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;
      const type = classifyUrl(url);
      if (!type) return;
      const tab = getTab(details.tabId);
      tab[type].set(url, Date.now());
      updateBadge(details.tabId);
    },
    {
      urls: ["https://*.cdninstagram.com/*", "https://*.fbcdn.net/*"],
      types: ["media", "xmlhttprequest", "image", "other"]
    }
  );
} catch (e) {
  console.warn("[IMD] webRequest not available:", e.message);
}

function classifyUrl(url) {
  // Skip profile pics
  if (url.includes("/t51.2885-19/")) return null;
  // Video: scontent + .mp4 pattern (Instagram video CDN URLs)
  if (url.includes(".mp4") || url.includes("/v/")) return "videos";
  // Large images (skip s150x150, stickers, story elements)
  if ((url.includes(".jpg") || url.includes(".webp")) &&
      !url.includes("s150x150") && !url.includes("/sticker/")) {
    return "images";
  }
  return null;
}

function getTab(tabId) {
  if (!capturedMedia.has(tabId)) {
    capturedMedia.set(tabId, { videos: new Map(), images: new Map(), thumbnails: {} });
  }
  return capturedMedia.get(tabId);
}

function updateBadge(tabId) {
  const tab = capturedMedia.get(tabId);
  const count = tab ? tab.videos.size + tab.images.size : 0;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#E1306C", tabId });
}

// ── Message router ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    const fn = handlers[msg?.type];
    if (fn) { fn(msg, sender, sendResponse); return true; }
  } catch (e) {
    console.error("[IMD] Handler error:", e);
    sendResponse({ ok: false, error: e.message });
  }
  return false;
});

const handlers = {
  GET_CAPTURED_URLS(msg, sender, respond) {
    const tabId = msg.tabId || sender.tab?.id;
    const tab = tabId ? capturedMedia.get(tabId) : null;
    respond({
      ok: true,
      urls: tab ? [...tab.videos.keys()] : [],
      imageUrls: tab ? [...tab.images.keys()] : [],
      thumbnails: tab?.thumbnails || {}
    });
  },

  async FETCH_EMBED_VIDEOS(msg, _s, respond) {
    try {
      respond({ ok: true, videoUrls: await fetchEmbed(msg.postUrl) });
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  async DOWNLOAD_MEDIA(msg, _s, respond) {
    try {
      await download(msg.url, msg.filename);
      respond({ ok: true });
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  async DOWNLOAD_VIDEO(msg, _s, respond) {
    try {
      await download(msg.url, msg.filename);
      respond({ ok: true });
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  EXTRACT_FROM_SCRIPTS(msg, sender, respond) {
    const tabId = sender.tab?.id;
    if (tabId && msg.urls?.length) {
      const tab = getTab(tabId);
      for (const url of msg.urls) {
        if (url.includes(".mp4") || url.includes("/v/")) {
          tab.videos.set(url, Date.now());
        } else {
          tab.images.set(url, Date.now());
        }
      }
      if (msg.thumbnails && tabId) {
        if (!tab.thumbnails) tab.thumbnails = {};
        Object.assign(tab.thumbnails, msg.thumbnails);
      }
      updateBadge(tabId);
    }
    respond({ ok: true });
  }
};

// ── Download: fetch -> blob -> downloads API (adds Referer header) ──
async function download(url, filename) {
  if (!url || url.startsWith("blob:")) {
    throw new Error("Cannot download blob: URL");
  }
  // Instagram CDN requires Referer: https://www.instagram.com/
  const resp = await fetch(url, {
    headers: { "Referer": "https://www.instagram.com/" }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: blobUrl,
        filename: sanitize(filename || `instagram/${Date.now()}.mp4`),
        saveAs: false,
        conflictAction: "uniquify"
      },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      }
    );
  });
}

// ── Embed fallback ──
async function fetchEmbed(postUrl) {
  if (!postUrl) throw new Error("No URL");
  const embedUrl = postUrl.replace(/\/(media)?\s*$/, "").replace(/\/$/, "") + "/embed";
  const res = await fetch(embedUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const urls = [];
  let m;
  const re1 = /<source\s+src="([^"]+)"/g;
  while ((m = re1.exec(html))) urls.push(decHtml(m[1]));
  const re2 = /<video[^>]+src="([^"]+)"/g;
  while ((m = re2.exec(html))) { const u = decHtml(m[1]); if (!urls.includes(u)) urls.push(u); }
  return urls;
}

function decHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function sanitize(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "_").trim().slice(0, 200);
}

// ── Cleanup ──
try {
  chrome.tabs.onRemoved.addListener((tabId) => capturedMedia.delete(tabId));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "loading") { capturedMedia.delete(tabId); updateBadge(tabId); }
  });
} catch (e) {
  console.warn("[IMD] tabs listeners error:", e.message);
}
