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
 * GET /api/drive-config hands the browser the Apps Script URL + token (see
 * README's Drive section) so it can POST a transcript to the Google Apps
 * Script "bridge" directly, saving it into a Drive folder as a .txt file.
 * This one deliberately happens browser-side, not through the Worker:
 * Google's front-door for script.google.com/exec rejects server-to-server
 * requests as automated traffic (confirmed live - a real User-Agent header
 * alone doesn't get past it), but real browser traffic goes through fine.
 * If APPS_SCRIPT_URL/APPS_SCRIPT_TOKEN aren't set, /api/drive-config just
 * reports { configured: false } instead of failing the whole app.
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

    if (url.pathname === "/api/drive-config" && request.method === "GET") {
      return handleDriveConfig(env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// Google's front-door for script.google.com/exec rejects Worker-originated
// (server-to-server) requests outright - HTTP 403 with a bot-mitigation
// challenge page instead of running the script, unaffected by a real
// User-Agent header (confirmed live: it needs an actual browser executing
// JS to get past, not just a header a Worker can fake). So instead of the
// Worker relaying the save, it hands the browser what it needs to POST to
// Apps Script directly - real browser traffic doesn't trigger the
// challenge. Trade-off: APPS_SCRIPT_URL and the shared secret token become
// visible in the page's own network traffic (they have to be, for the
// browser to make the call) - fine for a personal tool only you use, but
// worth knowing if this ever became a shared/public deployment.
async function handleDriveConfig(env) {
  const appsScriptUrl = await env.APPS_SCRIPT_URL?.get();
  const appsScriptToken = await env.APPS_SCRIPT_TOKEN?.get();
  if (!appsScriptUrl || !appsScriptToken) {
    return new Response(JSON.stringify({ configured: false }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ configured: true, url: appsScriptUrl, token: appsScriptToken }), {
    headers: { "content-type": "application/json" },
  });
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

    // Secrets Store bindings are objects with an async .get() method, not
    // plain strings - env.ASSEMBLYAI_API_KEY itself is truthy even when
    // unset, so the actual value has to be resolved before it can be
    // checked (this was the actual cause of "invalid API key" errors from
    // PodcastIndex even with correct secret values - the raw binding object
    // was being sent as the header value instead of the real key).
    const assemblyAiKey = await env.ASSEMBLYAI_API_KEY?.get();
    if (!assemblyAiKey) {
      return jsonError(
        "Podcast transcription isn't connected yet - set the ASSEMBLYAI_API_KEY Worker secret (see README's Podcast section)."
      );
    }
    const podcastIndexKey = await env.PODCASTINDEX_API_KEY?.get();
    const podcastIndexSecret = await env.PODCASTINDEX_API_SECRET?.get();
    if (!podcastIndexKey || !podcastIndexSecret) {
      return jsonError(
        "Podcast episode lookup isn't connected yet - set the PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET Worker secrets (see README's Podcast section)."
      );
    }

    const episode = await resolvePodcastEpisode(podcastUrl, podcastIndexKey, podcastIndexSecret);
    const transcriptId = await startAssemblyAITranscription(episode.audioUrl, assemblyAiKey);

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
    const assemblyAiKey = await env.ASSEMBLYAI_API_KEY?.get();
    if (!assemblyAiKey) {
      return jsonError("Podcast transcription isn't connected yet - set the ASSEMBLYAI_API_KEY Worker secret.");
    }

    const data = await getAssemblyAIStatus(id, assemblyAiKey);
    if (data.status === "error") {
      return jsonError(data.error || "Transcription failed.");
    }
    if (data.status !== "completed") {
      return new Response(JSON.stringify({ status: data.status }), {
        headers: { "content-type": "application/json" },
      });
    }

    const paragraphs = await getAssemblyAIParagraphs(id, assemblyAiKey);
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
//   https://podcasts.apple.com/us/podcast/episode-title-slug/id1200361736?i=1000552334455
// id1200361736 is the show's Apple "collection" id; i=... is the specific
// episode's Apple "track" id (required - a link to just the show, no `i`
// param, doesn't identify a single episode). The path segment between
// "/podcast/" and "/id..." is *not* the show's name, it's a hyphenated,
// sometimes-truncated version of the episode's own title - useful later for
// matching, since Apple's iTunes API blocks Cloudflare Workers outright
// (see below) and can't give us that title directly anymore.
function parseApplePodcastsUrl(input) {
  try {
    const u = new URL(input.trim());
    if (!/(^|\.)podcasts\.apple\.com$/i.test(u.hostname)) return null;
    const collectionMatch = u.pathname.match(/\/podcast\/([^/]+)\/id(\d+)/);
    if (!collectionMatch) return null;
    const titleSlug = collectionMatch[1];
    const collectionId = collectionMatch[2];
    const episodeId = u.searchParams.get("i");
    return { collectionId, episodeId, titleSlug };
  } catch {
    return null;
  }
}

// Apple's own iTunes lookup API (itunes.apple.com) returns a bare HTTP 403
// on every request from Cloudflare Workers - confirmed live, not just a
// missing-header issue (a real browser User-Agent didn't help either), so
// it looks like Apple blocks Workers' IP ranges outright rather than doing
// per-request bot detection. PodcastIndex.org is used instead: a
// third-party podcast database built for exactly this kind of API access
// (unlike Apple's, which isn't really meant for third-party use), and it
// returns each episode's enclosure (audio) URL directly - no separate RSS
// fetch needed either. Requires a free PODCASTINDEX_API_KEY/_SECRET pair.
const PODCASTINDEX_BASE = "https://api.podcastindex.org/api/1.0";

async function podcastIndexAuthHeaders(apiKey, apiSecret) {
  const apiHeaderTime = Math.floor(Date.now() / 1000).toString();
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(apiKey + apiSecret + apiHeaderTime));
  const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    "User-Agent": USER_AGENT,
    "X-Auth-Key": apiKey,
    "X-Auth-Date": apiHeaderTime,
    Authorization: hashHex,
  };
}

async function podcastIndexEpisodesByItunesId(collectionId, apiKey, apiSecret) {
  const headers = await podcastIndexAuthHeaders(apiKey, apiSecret);
  const res = await fetch(`${PODCASTINDEX_BASE}/episodes/byitunesid?id=${encodeURIComponent(collectionId)}&max=1000`, {
    headers,
  });
  if (!res.ok) {
    const bodySnippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`PodcastIndex lookup returned HTTP ${res.status}${bodySnippet ? ` - ${bodySnippet}` : ""}.`);
  }
  const data = await res.json().catch(() => null);
  if (!data?.items?.length) {
    throw new Error("PodcastIndex doesn't have any episodes indexed for that show.");
  }
  return data.items;
}

function normalizeSlugWords(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Common short/filler words excluded from matching - left in, they can
// coincidentally overlap between two completely unrelated episode titles
// and dilute the score away from the words that actually distinguish one
// episode from another.
const SLUG_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "this", "that", "these", "those", "who",
  "what", "how", "why", "most", "have", "has", "you", "your", "it", "its",
]);

function slugWordSet(s) {
  return new Set(
    normalizeSlugWords(s)
      .split(" ")
      .filter((w) => w.length > 2 && !SLUG_STOPWORDS.has(w))
  );
}

// Apple's URL slug is a hyphenated version of the episode title, but it's
// not always a clean prefix/substring match against the real title text -
// it can be truncated mid-word, drop small words, or the RSS/PodcastIndex
// title can differ slightly in wording or subtitle formatting from what
// Apple shows in its own app. Word-overlap scoring (order-independent,
// stopwords excluded) is far more tolerant of that than literal
// prefix/substring matching, while a high threshold still avoids
// confidently picking the wrong episode.
//
// Score is normalized against the *smaller* word set (slug vs. candidate)
// rather than their union, on purpose: Apple's slug is frequently a genuine
// truncation of a longer real title, so a candidate having extra words
// beyond the slug is the normal case, not a red flag, and shouldn't be
// penalized the way it would be under plain Jaccard similarity. The
// tradeoff: two real episodes whose titles differ only by a short suffix
// (e.g. "...For Kids") could occasionally be indistinguishable from the
// slug alone - accepted as a rare edge case in exchange for truncation
// tolerance on the much more common case.
function matchEpisodeBySlug(items, titleSlug) {
  const target = normalizeSlugWords(titleSlug);
  if (!target) return null;

  const exact = items.find((it) => normalizeSlugWords(it.title) === target);
  if (exact) return exact;

  const targetWords = slugWordSet(titleSlug);
  if (targetWords.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const words = slugWordSet(it.title);
    if (words.size === 0) continue;
    let overlap = 0;
    for (const w of targetWords) if (words.has(w)) overlap++;
    // Normalized against the smaller word set, since the slug is often a
    // truncated subset of the real title (or occasionally the reverse).
    const score = overlap / Math.min(targetWords.size, words.size);
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore >= 0.7 ? best : null;
}

// Resolves an Apple Podcasts episode link to its actual audio file URL via
// PodcastIndex, matching the specific episode by its URL-slug title (see
// parseApplePodcastsUrl) since PodcastIndex's episode objects don't carry
// Apple's own per-episode track id.
async function resolvePodcastEpisode(inputUrl, apiKey, apiSecret) {
  const parsed = parseApplePodcastsUrl(inputUrl);
  if (!parsed) {
    throw new Error(
      "Couldn't recognize that as an Apple Podcasts link. Paste a link from the Apple Podcasts app or podcasts.apple.com (Share > Copy Link on the episode)."
    );
  }
  const { collectionId, episodeId, titleSlug } = parsed;
  if (!episodeId) {
    throw new Error("That looks like a link to the show, not a specific episode. Open the episode itself, then Share > Copy Link.");
  }

  const items = await podcastIndexEpisodesByItunesId(collectionId, apiKey, apiSecret);
  const match = matchEpisodeBySlug(items, titleSlug);
  if (!match) {
    throw new Error(`Found this show on PodcastIndex but couldn't confidently match this episode by title inside it.`);
  }

  return {
    audioUrl: match.enclosureUrl,
    title: match.title || "Untitled episode",
    showTitle: match.feedTitle || "",
  };
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

  // Google rejects this call when the Worker makes it server-side (looks
  // like automated traffic to Apps Script's front-door), so the browser
  // POSTs to Apps Script directly instead - real browser traffic isn't
  // challenged the same way. /api/drive-config just hands over the URL and
  // token needed to do that; fetched once and cached for the session.
  let driveConfigPromise = null;
  function getDriveConfig() {
    if (!driveConfigPromise) driveConfigPromise = fetch('/api/drive-config').then((r) => r.json());
    return driveConfigPromise;
  }

  async function saveToDrive() {
    if (!lastData) return;
    const safeTitle = (lastData.title || 'transcript').replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    saveDriveBtn.disabled = true;
    driveStatus.textContent = 'Saving to Drive...';
    try {
      const config = await getDriveConfig();
      if (!config.configured) {
        throw new Error("Google Drive isn't connected yet - set the APPS_SCRIPT_URL and APPS_SCRIPT_TOKEN Worker secrets (see README's Drive section).");
      }
      const res = await fetch(config.url, {
        method: 'POST',
        // text/plain avoids a CORS preflight (Apps Script Web Apps don't
        // handle OPTIONS requests) - Apps Script reads the raw body
        // regardless of the declared content type, so JSON.parse on its
        // side still works fine.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: config.token, filename: safeTitle, text: out.value })
      });
      const bodyText = await res.text();
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error('Apps Script returned a non-JSON response (HTTP ' + res.status + ')');
      }
      if (data.error) throw new Error(data.error);
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
