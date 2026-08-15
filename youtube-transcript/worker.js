/**
 * Transcript Extractor - Cloudflare Worker
 *
 * Serves a mobile-friendly page at GET / where you paste a YouTube URL or an
 * Apple Podcasts episode link and get back a transcript (plain text or with
 * timestamps), ready to copy or download and drop into a doc for
 * podcast/blog work.
 *
 * POST /api/transcript { url } handles YouTube: fetches the video's existing
 * captions server-side (YouTube's caption endpoints don't send CORS headers,
 * so this can't run purely in the browser).
 *
 * POST /api/podcast/start { url } + GET /api/podcast/status?id=...  handle
 * Apple Podcasts: resolves the episode link to its actual audio file (via
 * Apple's iTunes lookup API and, if needed, the show's own RSS feed), then
 * hands that URL to AssemblyAI to transcribe. Podcasts don't usually ship
 * existing captions the way YouTube does, so this is real speech-to-text,
 * not caption-fetching - AssemblyAI does the actual transcription
 * server-side (fetching the audio itself from the URL we give it), which is
 * why this still fits in a Worker: we're only ever passing URLs and polling
 * for a result, never handling the audio bytes ourselves. Needs the
 * ASSEMBLYAI_API_KEY Worker secret - see README's Podcast section.
 *
 * Spotify episode links are explicitly not supported: Spotify has no public
 * API or link that resolves to a downloadable audio file (podcast audio is
 * served through their app's own DRM'd streaming), so there's no way to get
 * from a Spotify link to something AssemblyAI (or anything else) can fetch.
 *
 * POST /api/save-to-drive { filename, text } optionally relays a transcript
 * to a small Google Apps Script "bridge" (see README) which drops it into a
 * Google Drive folder. Configured via the APPS_SCRIPT_URL and
 * APPS_SCRIPT_TOKEN Worker secrets - if unset, the button just reports
 * Drive isn't connected yet rather than failing the whole app.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcript" && request.method === "POST") {
      return handleTranscriptRequest(request);
    }

    if (url.pathname === "/api/podcast/start" && request.method === "POST") {
      return handlePodcastStart(request, env);
    }

    if (url.pathname === "/api/podcast/status" && request.method === "GET") {
      return handlePodcastStatus(request, env);
    }

    if (url.pathname === "/api/save-to-drive" && request.method === "POST") {
      return handleSaveToDrive(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleSaveToDrive(request, env) {
  try {
    if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_TOKEN) {
      return jsonError(
        "Google Drive isn't connected yet - set the APPS_SCRIPT_URL and APPS_SCRIPT_TOKEN Worker secrets (see README's Drive section)."
      );
    }
    const { filename, text } = await request.json();
    if (!text) return jsonError("No transcript text to save.");
    const safeName = (filename || "transcript").replace(/[^a-z0-9\-_. ]+/gi, "-").slice(0, 120);

    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: env.APPS_SCRIPT_TOKEN,
        filename: safeName,
        text,
      }),
      redirect: "follow",
    });
    const data = await res.json();
    if (data.error) return jsonError(`Google Drive save failed: ${data.error}`);

    return new Response(JSON.stringify({ link: data.link }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return jsonError(`Drive save failed: ${err.message || err}`);
  }
}

async function handleTranscriptRequest(request) {
  try {
    const { url: videoUrl, lang } = await request.json();
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return jsonError("Couldn't find a video ID in that URL. Paste a full YouTube link (or just the 11-character video ID).");
    }

    const { status: httpStatus, playerResponse } = await fetchPlayerResponse(videoId);
    if (!playerResponse?.videoDetails && !playerResponse?.playabilityStatus) {
      // Temporary debug info - shows what YouTube actually sent back so we
      // can tell a block/bot-check response apart from a real API change.
      const snippet = JSON.stringify(playerResponse).slice(0, 350);
      return jsonError(
        `YouTube didn't return the expected data (HTTP ${httpStatus}). Debug: ${snippet}`
      );
    }

    const status = playerResponse?.playabilityStatus?.status;
    if (status && status !== "OK") {
      const reason = playerResponse?.playabilityStatus?.reason || status;
      return jsonError(`This video isn't accessible for transcript extraction: ${reason}`);
    }

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      return jsonError("This video has no captions/transcript available.");
    }

    const track = pickTrack(tracks, lang || "en");
    const segments = await fetchAndParseTranscript(track.baseUrl);

    return new Response(
      JSON.stringify({
        title: playerResponse?.videoDetails?.title || "Untitled video",
        videoId,
        language: track.languageCode,
        isAutoGenerated: track.kind === "asr",
        availableLanguages: tracks.map((t) => ({
          code: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
          auto: t.kind === "asr",
        })),
        segments,
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return jsonError(`Something went wrong: ${err.message || err}`);
  }
}

function jsonError(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function extractVideoId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2];
    if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2];
    if (u.searchParams.has("v")) return u.searchParams.get("v");
  } catch {
    // not a URL, fall through
  }
  return null;
}

// YouTube's public "WEB" client key, embedded in every youtube.com page
// load's JS bundle - not a secret credential, just an API key that scopes
// requests to the same internal endpoint the YouTube web player itself
// calls to load a video. Used here instead of scraping the rendered watch
// page, which YouTube's anti-bot system blocks from datacenter IPs
// (Cloudflare Workers included) with an HTTP 429 "unusual traffic" page.
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT_VERSION = "2.20240101.00.00";

async function fetchPlayerResponse(videoId) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      // The innertube endpoint checks these against what YouTube's own web
      // player actually sends - without them it can reject the request
      // outright (HTTP 403) regardless of IP reputation.
      Origin: "https://www.youtube.com",
      Referer: `https://www.youtube.com/watch?v=${videoId}`,
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": INNERTUBE_CLIENT_VERSION,
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: "WEB",
          clientVersion: INNERTUBE_CLIENT_VERSION,
          hl: "en",
          gl: "US",
          platform: "DESKTOP",
          userAgent: USER_AGENT,
        },
      },
    }),
  });
  const playerResponse = await res.json().catch(() => null);
  return { status: res.status, playerResponse };
}

function pickTrack(tracks, preferredLang) {
  const manualIn = (lang) => tracks.find((t) => t.languageCode === lang && t.kind !== "asr");
  const anyIn = (lang) => tracks.find((t) => t.languageCode === lang);
  return (
    manualIn(preferredLang) ||
    anyIn(preferredLang) ||
    tracks.find((t) => t.kind !== "asr") ||
    tracks[0]
  );
}

async function fetchAndParseTranscript(baseUrl) {
  const res = await fetch(baseUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  const xml = await res.text();
  const segments = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = decodeEntities(m[3]).replace(/\s+/g, " ").trim();
    if (!text) continue;
    segments.push({ start: parseFloat(m[1]), dur: parseFloat(m[2]), text });
  }
  return segments;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

// ── PODCAST TRANSCRIPTS (Apple Podcasts -> AssemblyAI) ─────────────────────

async function handlePodcastStart(request, env) {
  try {
    const { url: podcastUrl } = await request.json();
    if (!podcastUrl) return jsonError("Paste a podcast episode link first.");

    if (/open\.spotify\.com/i.test(podcastUrl)) {
      return jsonError(
        "Spotify doesn't allow extracting episode audio outside their app - there's no public link or API that resolves to a downloadable file. Try the same episode's Apple Podcasts link instead (most shows are on both)."
      );
    }

    if (!env.ASSEMBLYAI_API_KEY) {
      return jsonError(
        "Podcast transcription isn't connected yet - set the ASSEMBLYAI_API_KEY Worker secret (see README's Podcast section)."
      );
    }

    const episode = await resolvePodcastEpisode(podcastUrl);
    const transcriptId = await startAssemblyAITranscription(episode.audioUrl, env.ASSEMBLYAI_API_KEY);

    return new Response(
      JSON.stringify({
        transcriptId,
        title: episode.title,
        showTitle: episode.showTitle,
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return jsonError(err.message || String(err));
  }
}

async function handlePodcastStatus(request, env) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return jsonError("Missing transcript id.");
    if (!env.ASSEMBLYAI_API_KEY) {
      return jsonError("Podcast transcription isn't connected yet - set the ASSEMBLYAI_API_KEY Worker secret.");
    }

    const data = await getAssemblyAIStatus(id, env.ASSEMBLYAI_API_KEY);
    if (data.status === "error") {
      return jsonError(data.error || "Transcription failed.");
    }
    if (data.status !== "completed") {
      return new Response(JSON.stringify({ status: data.status }), {
        headers: { "content-type": "application/json" },
      });
    }

    const paragraphs = await getAssemblyAIParagraphs(id, env.ASSEMBLYAI_API_KEY);
    return new Response(
      JSON.stringify({
        status: "completed",
        segments: segmentsFromParagraphs(paragraphs),
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return jsonError(err.message || String(err));
  }
}

// Apple Podcasts episode links look like:
//   https://podcasts.apple.com/us/podcast/show-name/id1200361736?i=1000552334455
// id1200361736 is the show's Apple "collection" id; i=... is the specific
// episode's Apple "track" id. Both are needed - a link to just the show
// (no `i` param) doesn't identify a single episode. The leading /us/ is
// Apple's storefront country code - carried through to the lookup call
// below, since the lookup API is unreliable without an explicit country.
function parseApplePodcastsUrl(input) {
  try {
    const u = new URL(input.trim());
    if (!/(^|\.)podcasts\.apple\.com$/i.test(u.hostname)) return null;
    const countryMatch = u.pathname.match(/^\/([a-z]{2})\//i);
    const country = countryMatch ? countryMatch[1].toUpperCase() : "US";
    const collectionMatch = u.pathname.match(/\/id(\d+)/);
    const collectionId = collectionMatch ? collectionMatch[1] : null;
    const episodeId = u.searchParams.get("i");
    if (!collectionId) return null;
    return { collectionId, episodeId, country };
  } catch {
    return null;
  }
}

// Looking up a single episode directly by its track id
// (entity=podcastEpisode&id=<episodeId>) is unreliable in practice - Apple's
// directory frequently returns zero results for real, valid episode ids.
// The reliable path (confirmed against Apple's own developer forums, since
// this entity type isn't in their official docs) is looking up the *show*
// with media=podcast&entity=podcastEpisode - which returns the show itself
// as results[0] plus its ~200 most recent episodes as results[1..] - then
// matching by track id within that list. Both `media=podcast` and
// `country` are required for reliable results; entity alone isn't enough.
async function itunesLookupShowWithEpisodes(collectionId, country) {
  const res = await fetch(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}&country=${encodeURIComponent(country)}&media=podcast&entity=podcastEpisode&limit=200`
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.results?.length ? data.results : null;
}

// Resolves an Apple Podcasts episode link to its actual audio file URL.
// Fast path: Apple's episode listing sometimes includes the audio URL
// directly. Fallback: look up the show's RSS feed and match this episode
// inside it by title/release date, then read the <enclosure> URL - the same
// technique most third-party podcast apps use, since Apple's directory
// itself is just an index over each show's own RSS feed.
async function resolvePodcastEpisode(inputUrl) {
  const parsed = parseApplePodcastsUrl(inputUrl);
  if (!parsed) {
    throw new Error(
      "Couldn't recognize that as an Apple Podcasts link. Paste a link from the Apple Podcasts app or podcasts.apple.com (Share > Copy Link on the episode)."
    );
  }
  const { collectionId, episodeId, country } = parsed;
  if (!episodeId) {
    throw new Error("That looks like a link to the show, not a specific episode. Open the episode itself, then Share > Copy Link.");
  }

  const results = await itunesLookupShowWithEpisodes(collectionId, country);
  if (!results) {
    throw new Error("Apple's podcast directory doesn't recognize that show.");
  }
  const showMeta = results[0];
  const episodeMeta = results.slice(1).find((r) => String(r.trackId) === String(episodeId));

  if (!episodeMeta) {
    // Apple's episode listing only covers the ~200 most recent episodes, so
    // older back-catalog episodes land here with no title/date to match on -
    // no point fetching the RSS feed, there's nothing to match against.
    throw new Error(
      `That episode isn't in "${showMeta.collectionName}"'s recent-episodes list from Apple (older back-catalog episodes beyond the most recent ~200 aren't supported yet).`
    );
  }

  if (episodeMeta.episodeUrl) {
    return {
      audioUrl: episodeMeta.episodeUrl,
      title: episodeMeta.trackName || "Untitled episode",
      showTitle: showMeta.collectionName || "",
    };
  }

  if (!showMeta.feedUrl) {
    throw new Error("Couldn't find this show's RSS feed via Apple's directory.");
  }
  const rssRes = await fetch(showMeta.feedUrl, { headers: { "User-Agent": USER_AGENT } });
  if (!rssRes.ok) {
    throw new Error(`Couldn't fetch the show's RSS feed (HTTP ${rssRes.status}).`);
  }
  const items = parseRssItems(await rssRes.text());

  // Apple knows this episode's title/release date even without a direct
  // audio URL for it - use those to match it into the feed.
  const match = matchEpisodeInFeed(items, episodeMeta.trackName, episodeMeta.releaseDate);
  if (match) {
    return {
      audioUrl: match.enclosureUrl,
      title: episodeMeta.trackName || match.title || "Untitled episode",
      showTitle: showMeta.collectionName || "",
    };
  }
  throw new Error(`Found "${showMeta.collectionName}"'s feed but couldn't confidently match "${episodeMeta.trackName}" inside it.`);
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const enclosureMatch = block.match(/<enclosure\b[^>]*\burl="([^"]+)"[^>]*\/?>/i);
    if (!enclosureMatch) continue; // no audio in this item, nothing to match against
    items.push({
      title: decodeEntities(extractRssTag(block, "title") || "").trim(),
      pubDate: extractRssTag(block, "pubDate"),
      enclosureUrl: decodeEntities(enclosureMatch[1]),
    });
  }
  return items;
}

// Handles both `<title>Text</title>` and `<title><![CDATA[Text]]></title>`.
function extractRssTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1] : raw;
}

function normalizeEpisodeTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchEpisodeInFeed(items, targetTitle, targetReleaseDate) {
  const normTarget = normalizeEpisodeTitle(targetTitle);

  const exact = items.find((it) => normTarget && normalizeEpisodeTitle(it.title) === normTarget);
  if (exact) return exact;

  // No exact title match - narrow by release date first (within 3 days, to
  // allow for feed-vs-directory timezone/republish drift), then prefer
  // whichever of those has the closest title.
  const targetTime = targetReleaseDate ? Date.parse(targetReleaseDate) : NaN;
  if (!isNaN(targetTime)) {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const nearInTime = items
      .map((it) => ({ it, dt: Date.parse(it.pubDate) }))
      .filter(({ dt }) => !isNaN(dt) && Math.abs(dt - targetTime) <= THREE_DAYS_MS)
      .sort((a, b) => Math.abs(a.dt - targetTime) - Math.abs(b.dt - targetTime));
    if (nearInTime.length) {
      const titleish = nearInTime.find(
        ({ it }) => normTarget && (normalizeEpisodeTitle(it.title).includes(normTarget) || normTarget.includes(normalizeEpisodeTitle(it.title)))
      );
      return (titleish || nearInTime[0]).it;
    }
  }

  // Last resort: partial title containment, no usable date to lean on.
  return (
    items.find(
      (it) => normTarget && (normalizeEpisodeTitle(it.title).includes(normTarget) || normTarget.includes(normalizeEpisodeTitle(it.title)))
    ) || null
  );
}

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";

async function startAssemblyAITranscription(audioUrl, apiKey) {
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.id) {
    throw new Error(data?.error || `AssemblyAI rejected the transcription request (HTTP ${res.status}).`);
  }
  return data.id;
}

async function getAssemblyAIStatus(id, apiKey) {
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
    headers: { Authorization: apiKey },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(`Couldn't check transcription status (HTTP ${res.status}).`);
  }
  return data;
}

async function getAssemblyAIParagraphs(id, apiKey) {
  const res = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}/paragraphs`, {
    headers: { Authorization: apiKey },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(`Couldn't fetch the finished transcript (HTTP ${res.status}).`);
  }
  return data.paragraphs || [];
}

// AssemblyAI paragraph start/end are in milliseconds; segments elsewhere in
// this app use seconds (matching YouTube's caption track units), so convert
// here once rather than at every call site.
function segmentsFromParagraphs(paragraphs) {
  return paragraphs.map((p) => ({
    start: p.start / 1000,
    dur: Math.max(0, (p.end - p.start) / 1000),
    text: p.text.trim(),
  }));
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript Extractor</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1a1a1a;
    --muted: #6b6b6b;
    --border: #ddd;
    --accent: #c4302b;
    --accent-text: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121212;
      --card: #1e1e1e;
      --text: #f0f0f0;
      --muted: #a0a0a0;
      --border: #333;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 16px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 20px; font-size: 0.9rem; }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
  }
  input[type=text] {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }
  button {
    font-size: 16px;
    padding: 12px 16px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-weight: 600;
  }
  .btn-primary {
    background: var(--accent);
    color: var(--accent-text);
    width: 100%;
    margin-top: 10px;
  }
  .btn-primary:disabled { opacity: 0.6; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .btn-row button {
    flex: 1 1 auto;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
  }
  #status { margin-top: 10px; font-size: 0.9rem; color: var(--muted); min-height: 1.2em; }
  #driveStatus { margin-top: 8px; font-size: 0.85rem; color: var(--muted); min-height: 1.2em; }
  #driveStatus a { color: var(--text); }
  #error { color: var(--accent); font-size: 0.9rem; margin-top: 10px; display: none; }
  #result { display: none; }
  #meta { font-size: 0.9rem; color: var(--muted); margin-bottom: 10px; }
  textarea {
    width: 100%;
    min-height: 40vh;
    font-size: 15px;
    line-height: 1.5;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    resize: vertical;
  }
  label.toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    color: var(--muted);
    margin-bottom: 10px;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Transcript Extractor</h1>
  <p class="sub">Paste a YouTube link or an Apple Podcasts episode link, get the transcript, copy it into your podcast/blog notes.</p>

  <div class="card">
    <input type="text" id="urlInput" placeholder="YouTube or Apple Podcasts episode link..." inputmode="url" autocapitalize="off" autocorrect="off">
    <button class="btn-primary" id="fetchBtn">Get Transcript</button>
    <div id="status"></div>
    <div id="error"></div>
  </div>

  <div class="card" id="result">
    <div id="meta"></div>
    <label class="toggle"><input type="checkbox" id="timestampToggle"> Show timestamps</label>
    <textarea id="transcriptOut" readonly></textarea>
    <div class="btn-row">
      <button id="copyBtn">Copy</button>
      <button id="downloadTxtBtn">Download .txt</button>
      <button id="saveDriveBtn">Save to Drive again</button>
    </div>
    <div id="driveStatus"></div>
  </div>
</div>

<script>
  const urlInput = document.getElementById('urlInput');
  const fetchBtn = document.getElementById('fetchBtn');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const resultEl = document.getElementById('result');
  const metaEl = document.getElementById('meta');
  const out = document.getElementById('transcriptOut');
  const timestampToggle = document.getElementById('timestampToggle');
  const copyBtn = document.getElementById('copyBtn');
  const downloadTxtBtn = document.getElementById('downloadTxtBtn');
  const saveDriveBtn = document.getElementById('saveDriveBtn');
  const driveStatus = document.getElementById('driveStatus');

  let lastData = null;

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function render() {
    if (!lastData) return;
    const withTs = timestampToggle.checked;
    out.value = lastData.segments
      .map(seg => withTs ? '[' + formatTime(seg.start) + '] ' + seg.text : seg.text)
      .join(withTs ? '\\n' : ' ');
  }

  timestampToggle.addEventListener('change', render);

  function detectSource(url) {
    if (/open\\.spotify\\.com/i.test(url)) return 'spotify';
    if (/podcasts\\.apple\\.com/i.test(url)) return 'applepodcasts';
    return 'youtube';
  }

  async function pollPodcastStatus(transcriptId) {
    const started = Date.now();
    while (true) {
      await new Promise((r) => setTimeout(r, 4000));
      const elapsedSec = Math.round((Date.now() - started) / 1000);
      if (elapsedSec > 900) {
        throw new Error('Transcription is taking unusually long (15+ min) - giving up. Try again later.');
      }
      statusEl.textContent = 'Transcribing... ' + elapsedSec + 's elapsed (full episodes can take a few minutes)';
      const res = await fetch('/api/podcast/status?id=' + encodeURIComponent(transcriptId));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unknown error');
      if (data.status === 'completed') return data;
    }
  }

  fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    errorEl.style.display = 'none';
    resultEl.style.display = 'none';
    driveStatus.textContent = '';

    const source = detectSource(url);
    if (source === 'spotify') {
      errorEl.textContent = "Spotify doesn't allow extracting episode audio outside their app - there's no public link or API that resolves to a downloadable file. Try the same episode's Apple Podcasts link instead (most shows are on both).";
      errorEl.style.display = 'block';
      return;
    }

    fetchBtn.disabled = true;
    try {
      if (source === 'applepodcasts') {
        statusEl.textContent = 'Finding the episode...';
        const startRes = await fetch('/api/podcast/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const startData = await startRes.json();
        if (!startRes.ok) throw new Error(startData.error || 'Unknown error');

        const finished = await pollPodcastStatus(startData.transcriptId);
        lastData = { title: startData.title, segments: finished.segments, isAutoGenerated: false };
        metaEl.textContent = (startData.showTitle ? startData.showTitle + ' — ' : '') + startData.title + ' — ' + finished.segments.length + ' segments';
      } else {
        statusEl.textContent = 'Fetching transcript...';
        const res = await fetch('/api/transcript', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unknown error');
        lastData = data;
        metaEl.textContent = data.title + (data.isAutoGenerated ? ' (auto-generated captions)' : '') + ' — ' + data.segments.length + ' segments';
      }
      render();
      resultEl.style.display = 'block';
      statusEl.textContent = '';
      // Auto-save to Drive right away - by the time you're looking at the
      // transcript, it's already backed up, no extra tap needed. Silently
      // no-ops (via saveToDrive's own error text) if Drive isn't connected.
      saveToDrive();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
      statusEl.textContent = '';
    } finally {
      fetchBtn.disabled = false;
    }
  });

  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(out.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy', 1500);
  });

  downloadTxtBtn.addEventListener('click', () => {
    const blob = new Blob([out.value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safeTitle = (lastData?.title || 'transcript').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    a.download = safeTitle + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  async function saveToDrive() {
    if (!lastData) return;
    const safeTitle = (lastData.title || 'transcript').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    saveDriveBtn.disabled = true;
    driveStatus.textContent = 'Saving to Drive...';
    try {
      const res = await fetch('/api/save-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: safeTitle, text: out.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unknown error');
      driveStatus.innerHTML = 'Saved to Drive as a .txt file — <a href="' + data.link + '" target="_blank" rel="noopener">open file</a>';
    } catch (err) {
      driveStatus.textContent = 'Drive save failed: ' + err.message;
    } finally {
      saveDriveBtn.disabled = false;
    }
  }

  saveDriveBtn.addEventListener('click', saveToDrive);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchBtn.click();
  });
</script>
</body>
</html>
`;
