/*
 * Background service worker - Instagram Media Downloader v4
 * - Captures CDN URLs from webRequest
 * - Downloads via chrome.downloads (direct URL, no fetch→blob)
 * - Instagram GraphQL API fallback
 * - Embed page fallback
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
      urls: [
        "https://*.cdninstagram.com/*",
        "https://*.fbcdn.net/*",
        "https://*.instagram.com/*"
      ],
      types: ["media", "xmlhttprequest", "image", "other"]
    }
  );
} catch (e) {
  console.warn("[IMD] webRequest not available:", e.message);
}

function classifyUrl(url) {
  if (url.includes("/t51.2885-19/")) return null; // profile pic
  if (url.includes(".mp4") || url.includes("/v/")) return "videos";
  if ((url.includes(".jpg") || url.includes(".webp") || url.includes(".png")) &&
      !url.includes("s150x150") && !url.includes("/sticker/") && !url.includes("/t15/") && !url.includes("/t32/")) {
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

  async FETCH_GRAPHQL_MEDIA(msg, _sender, respond) {
    try {
      const result = await fetchGraphQLMedia(msg.postUrl);
      respond(result);
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  async EXTRACT_HLS(msg, _sender, respond) {
    try {
      const mp4Url = await extractHLStoMP4(msg.manifestUrl);
      respond({ ok: true, url: mp4Url });
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  async FETCH_EMBED_VIDEOS(msg, _sender, respond) {
    try {
      respond({ ok: true, videoUrls: await fetchEmbedVideos(msg.postUrl) });
    } catch (e) {
      respond({ ok: false, error: e.message });
    }
  },

  async DOWNLOAD_MEDIA(msg, _sender, respond) {
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
        if (url.includes(".mp4") || url.includes("/v/") || url.includes(".m3u8")) {
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

// ── Instagram GraphQL API fallback ──
async function fetchGraphQLMedia(postUrl) {
  if (!postUrl) throw new Error("No URL");

  const shortcode = extractShortcode(postUrl);
  if (!shortcode) throw new Error("No shortcode found");

  const graphqlUrl = `https://www.instagram.com/api/v1/media/${shortcode}/info/`;

  const resp = await fetch(graphqlUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "X-IG-App-ID": "936619743392459",
      "Referer": "https://www.instagram.com/"
    }
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  return digGraphQLData(data);
}

function digGraphQLData(obj) {
  if (!obj || typeof obj !== "object") return { ok: false };

  const items = obj?.items || obj?.data?.items || obj?.data?.media || [];
  const arr = Array.isArray(items) ? items : [items];

  for (const item of arr) {
    const media = item?.media || item;
    if (!media) continue;

    // Carousel
    if (Array.isArray(media.carousel_media)) {
      const results = [];
      for (const cm of media.carousel_media) {
        const r = digGraphQLData({ items: [cm] });
        if (r.ok) results.push(r);
      }
      if (results.length) return { ok: true, carousel: results };
    }

    if (media.video_versions) {
      const best = media.video_versions.reduce((a, b) =>
        (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a,
        media.video_versions[0]
      );
      if (best?.url) return { ok: true, url: best.url, thumb: media.image_versions2?.candidates?.[0]?.url || null };
    }
    if (media.video_url) return { ok: true, url: media.video_url, thumb: media.thumbnail?.url || null };
    if (media.image_versions2?.candidates) {
      const cands = media.image_versions2.candidates;
      const best = cands.reduce((a, b) =>
        (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a,
        cands[0]
      );
      return { ok: true, url: best?.url, thumb: best?.url };
    }
  }

  return { ok: false };
}

function extractShortcode(url) {
  const patterns = ["/p/", "/reel/", "/tv/", "/reels/", "/media/"];
  for (const p of patterns) {
    const idx = url.indexOf(p);
    if (idx !== -1) {
      const rest = url.slice(idx + p.length).split(/[/?#]/)[0];
      if (rest && rest.length >= 5) return rest;
    }
  }
  return null;
}

// ── HLS m3u8 → MP4 extraction ──
async function extractHLStoMP4(manifestUrl) {
  if (!manifestUrl) throw new Error("No manifest URL");

  const resp = await fetch(manifestUrl, {
    headers: { "Referer": "https://www.instagram.com/" }
  });
  if (!resp.ok) throw new Error(`Manifest HTTP ${resp.status}`);

  const text = await resp.text();
  const lines = text.split("\n").map((l) => l.trim());

  // Look for .mp4 directly
  const mp4Line = lines.find((l) => l.includes(".mp4") && l.startsWith("http"));
  if (mp4Line) return mp4Line;

  // Look for highest bandwidth variant playlist
  const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  const variants = [];
  let bandwidth = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
    } else if (line && !line.startsWith("#") && bandwidth > 0) {
      variants.push({ url: line.startsWith("http") ? line : baseUrl + line, bandwidth });
      bandwidth = 0;
    }
  }
  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return variants[0].url;
  }

  throw new Error("No extractable MP4 from HLS manifest");
}

// ── Embed page fallback ──
async function fetchEmbedVideos(postUrl) {
  if (!postUrl) throw new Error("No URL");

  // Try oEmbed API first
  try {
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(postUrl)}&maxwidth=1080`;
    const resp = await fetch(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (resp.ok) {
      const data = await resp.json();
      if (data.html) {
        const mp4Match = data.html.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
        if (mp4Match) return [mp4Match[1]];
      }
    }
  } catch { /* try next */ }

  // Direct /embed page
  const embedUrl = postUrl.replace(/(\/media)?\s*$/, "").replace(/\/$/, "") + "/embed/";
  try {
    const resp = await fetch(embedUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    });
    if (resp.ok) {
      const html = await resp.text();
      const urls = [];
      let m;
      const re1 = /<source\s+src="([^"]+)"/g;
      while ((m = re1.exec(html))) urls.push(decHtml(m[1]));
      const re2 = /<video[^>]+src="([^"]+)"/g;
      while ((m = re2.exec(html))) { const u = decHtml(m[1]); if (!urls.includes(u)) urls.push(u); }
      const re3 = /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/g;
      while ((m = re3.exec(html))) { const u = m[1]; if (!urls.includes(u)) urls.push(u); }
      if (urls.length) return urls;
    }
  } catch { /* failed */ }

  throw new Error("All embed methods failed");
}

function decHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

// ── Download: direct chrome.downloads (no fetch→blob) ──
function download(url, filename) {
  if (!url || url.startsWith("blob:")) {
    return Promise.reject(new Error("Cannot download blob URL"));
  }
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: sanitize(filename || `instagram/${Date.now()}.mp4`),
        saveAs: false,
        conflictAction: "uniquify"
      },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      }
    );
  });
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
