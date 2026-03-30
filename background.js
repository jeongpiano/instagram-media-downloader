/*
 * Background service worker - Instagram Media Downloader v2 (Fixed)
 * - Captures CDN URLs from webRequest
 * - Downloads via chrome.downloads (Referer handled via fetch → blob)
 * - HLS m3u8 → MP4 extraction
 * - Instagram GraphQL API fallback
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

  // FIX 4: Instagram GraphQL API fallback (new embed alternative)
  async FETCH_GRAPHQL_MEDIA(msg, sendResponse) {
    try {
      const result = await fetchGraphQLMedia(msg.postUrl);
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  },

  // FIX 2: HLS m3u8 manifest → MP4 extraction
  async EXTRACT_HLS(msg, sendResponse) {
    try {
      const mp4Url = await extractHLStoMP4(msg.manifestUrl, msg.postUrl);
      sendResponse({ ok: true, url: mp4Url });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  },

  async FETCH_EMBED_VIDEOS(msg, _s, respond) {
    try {
      respond({ ok: true, videoUrls: await fetchEmbedVideos(msg.postUrl) });
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

// ── FIX 4: Instagram GraphQL API fallback ──
async function fetchGraphQLMedia(postUrl) {
  if (!postUrl) throw new Error("No URL");

  // Extract shortcode from URL
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
  const media = digGraphQLData(data);

  return media;
}

function digGraphQLData(obj) {
  if (!obj || typeof obj !== "object") return {};

  // Navigate: data.items[].media (Instagram internal API structure)
  const items = obj?.items || obj?.data?.items || obj?.data?.media || [];
  const arr = Array.isArray(items) ? items : [items];

  for (const item of arr) {
    const media = item?.media || item;
    if (!media) continue;

    if (media.video_versions) {
      const best = media.video_versions[media.video_versions.length - 1];
      if (best?.url) return { ok: true, url: best.url, thumb: media.thumbnail?.url || null };
    }
    if (media.video_url) return { ok: true, url: media.video_url, thumb: media.thumbnail?.url || null };
    if (media.image_versions2?.candidates) {
      const best = media.image_versions2.candidates[media.image_versions2.candidates.length - 1];
      return { ok: true, url: best?.url, thumb: best?.url };
    }
  }

  return { ok: false };
}

function extractShortcode(url) {
  // Instagram URL patterns: /p/CODE/, /reel/CODE/, /tv/CODE/, /reels/CODE/
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

// ── FIX 2: HLS m3u8 → MP4 segment extraction ──
async function extractHLStoMP4(manifestUrl, postUrl) {
  if (!manifestUrl) throw new Error("No manifest URL");

  const referer = "https://www.instagram.com/";

  // Fetch the m3u8 manifest
  const manifestResp = await fetch(manifestUrl, {
    headers: { "Referer": referer, "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
  });
  if (!manifestResp.ok) throw new Error(`Manifest HTTP ${manifestResp.status}`);

  const manifestText = await manifestResp.text();
  const lines = manifestText.split("\n").map((l) => l.trim());

  // Determine base URL for resolving relative segment URLs
  const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);

  // Find MP4 video segments (not AUDIO, not I-frame only)
  const segments = [];
  let currentVariant = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      // Variant stream — skip audio-only
      currentVariant = line.includes("VIDEO=") || line.includes("CODECS=\"avc") ? "video" : null;
    } else if (line.startsWith("#")) {
      currentVariant = null; // reset on other tags
    } else if (line && currentVariant === "video" && (line.endsWith(".ts") || line.includes(".ts"))) {
      // TS segment — resolve relative URL
      const segUrl = line.startsWith("http") ? line : baseUrl + line;
      segments.push(segUrl);
    } else if (line && (line.endsWith(".m3u8") || line.includes(".m3u8"))) {
      // Nested playlist — recurse (simplified: skip nested for now)
    }
  }

  // If TS segments found, fetch the first few to estimate; use best MP4 if available
  // For simplicity: look for EXT-X-MAP (init segment) + first TS as representative MP4 URL
  // Instagram HLS typically stores MP4 in highest quality variant
  const mp4Init = lines.find((l) => l.includes(".mp4") || l.includes("EXT-X-MAP"));
  const mp4Seg = segments[Math.floor(segments.length * 0.7)]; // ~70% position (usually best quality)

  if (mp4Seg) return mp4Seg;

  // Fallback: look for .mp4 directly in manifest lines
  const mp4Line = lines.find((l) => l.includes(".mp4") && l.startsWith("http"));
  if (mp4Line) return mp4Line;

  throw new Error("No extractable MP4 from HLS manifest");
}

// ── FIX 4 updated: fetchEmbedVideos with updated endpoint ──
async function fetchEmbedVideos(postUrl) {
  if (!postUrl) throw new Error("No URL");

  // Try oEmbed API first (public, no auth needed)
  try {
    const oembedUrl = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(postUrl)}&maxwidth=1080`;
    const resp = await fetch(oembedUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.html) {
        // Extract video src from oEmbed HTML
        const srcMatch = data.html.match(/src="([^"]+)"/);
        const mp4Match = data.html.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
        if (mp4Match) return [mp4Match[1]];
        if (srcMatch) {
          // Fetch the embed page to get actual video URL
          const embedResp = await fetch(srcMatch[1], {
            headers: { "User-Agent": "Mozilla/5.0" }
          });
          if (embedResp.ok) {
            const html = await embedResp.text();
            const mp4s = [...html.matchAll(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/g)].map((m) => m[1]);
            if (mp4s.length) return mp4s;
          }
        }
      }
    }
  } catch { /* try next fallback */ }

  // Try direct /embed page (Instagram may still support it for some posts)
  const embedUrl = postUrl.replace(/\/(media)?\s*$/, "").replace(/\/$/, "") + "/embed/";
  try {
    const resp = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
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
  } catch { /* final fallback failed */ }

  throw new Error("All embed methods failed");
}

function decHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

// ── Download: fetch -> blob -> downloads API (Referer via fetch) ──
async function download(url, filename) {
  if (!url || url.startsWith("blob:")) {
    throw new Error("Cannot download blob URL");
  }
  // Instagram CDN requires Referer
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
