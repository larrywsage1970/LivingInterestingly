# Transcript Extractor

A tiny, self-contained web app: paste a YouTube link *or* an Apple Podcasts
episode link, get the transcript, copy or download it. Built for turning
long-form videos and podcast episodes into blog/podcast source material —
get the transcript here, then hand it to an LLM (or your own eyes) to pull
out key points and topics.

Everything — frontend and the fetch logic — lives in one file,
`worker.js`, deployed as a [Cloudflare Worker](https://workers.cloudflare.com/).
No database, no build step, free tier is generous enough that personal use
won't hit any limits.

## Why a Worker at all (not just a phone-only page)?

YouTube's caption endpoints don't send CORS headers, so a browser can't
fetch a transcript directly from JavaScript running on a page — something
has to fetch it server-to-server first. A Cloudflare Worker is the smallest
possible version of "something": no server to patch or keep alive, it's
just a URL that runs your code on request. You deploy it once (from a
computer), and from then on it's *only* a URL — everything after that is
phone-only, no laptop required.

The podcast path fits the same "just a URL" model for a different reason:
podcast transcription needs real speech-to-text, which is far more compute
than a Worker can do itself — but AssemblyAI's API accepts a source URL and
does the audio fetch *and* transcription entirely on their own servers. The
Worker's job stays lightweight either way: resolve a link to a URL, hand it
off, poll for a result. It never touches the podcast audio bytes directly.

Episode *resolution* (Apple Podcasts link → actual audio file URL) works the
same way for the same reason, but through
[PodcastIndex.org](https://podcastindex.org/) rather than Apple directly —
Apple's own iTunes lookup API returns a bare HTTP 403 on every request from
Cloudflare Workers (confirmed live: it's not a missing-header issue, a real
browser User-Agent didn't help either — this looks like Apple blocking
Workers' IP ranges outright). PodcastIndex is a third-party podcast
database built for exactly this kind of API access, so it doesn't have that
problem, and it can look up an episode from Apple's own show ID directly.

## One-time setup (from a computer)

Deploy via Cloudflare's **Git integration** so the Worker auto-deploys every
time this repo's `main` branch changes — no manual redeploy step after
today, same pattern as other apps that build straight from GitHub.

1. **Merge PR #1** into `main` (if not already done) so Cloudflare has
   something to deploy from.
2. **Create a free Cloudflare account** at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you
   don't have one.
3. Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to
   Git** (may also be labeled "Import a repository").
4. Authorize Cloudflare's GitHub App and select
   `larrywsage1970/servicedeskreporter`.
5. When asked for the project's root/working directory, set it to
   `youtube-transcript` — that's where `worker.js` and `wrangler.toml` live.
   Deploy branch: `main`. No build command needed, it's plain JS.
6. Deploy. You'll get a URL like
   `https://youtube-transcript-extractor.<your-subdomain>.workers.dev`.
   From now on, any push to `main` that touches this folder redeploys it
   automatically.

## Podcast transcripts (Apple Podcasts)

Paste an Apple Podcasts **episode** link (open the episode in the app or at
podcasts.apple.com, then Share > Copy Link — needs the `?i=...` episode ID
in the URL, not just a link to the show) and the Worker will:

1. Resolve that link to the episode's actual audio file: PodcastIndex looks
   up the show directly from Apple's own show ID (no separate feed-lookup
   step needed), then the specific episode is matched by title against
   Apple's URL slug (the hyphenated text between `/podcast/` and `/id...`
   in the link *is* the episode's title, truncated) — since PodcastIndex's
   episode data doesn't carry Apple's own per-episode ID.
2. Hand that audio URL to [AssemblyAI](https://www.assemblyai.com/) to
   transcribe. Unlike YouTube, most podcasts don't publish existing
   captions, so this is real speech-to-text, not caption-fetching.
3. Poll until it's done (a few minutes for a full episode is normal) and
   show the transcript exactly like the YouTube path does.

**Spotify links are not supported and never will be** — Spotify has no
public API or link that resolves to a downloadable audio file; podcast
audio is served through their app's own DRM'd streaming with no way around
it. If a show is on both, use its Apple Podcasts link instead.

### Setup

1. Sign up at [assemblyai.com](https://www.assemblyai.com/) and grab an API
   key from their dashboard (free usage tier, then pay-as-you-go per hour of
   audio transcribed).
2. Sign up at [api.podcastindex.org](https://api.podcastindex.org/) (free)
   and grab an **API key** and **API secret** — you need both, they're
   different from each other.
3. Add all three as secrets via Cloudflare's **Secrets Store** (Workers &
   Pages → Secrets Store → Create secret): `ASSEMBLYAI_API_KEY`,
   `PODCASTINDEX_API_KEY`, `PODCASTINDEX_API_SECRET`. Note the Store ID
   shown on that page.
4. Confirm `wrangler.toml`'s `[[secrets_store_secrets]]` block has an entry
   for each with the matching `store_id` (update it if your Store ID
   differs) — this is what makes the bindings survive every future deploy
   automatically. Secrets added only through the Worker's own
   Settings/Bindings pages by hand were found (the hard way) to *not*
   reliably survive the next git-triggered deploy.
5. That's it — no other config needed. If a secret isn't set, Apple
   Podcasts links just return a clear "not connected yet" message naming
   which one, instead of breaking the app; YouTube links work regardless.

## Connecting Google Drive (auto-save transcripts as .txt)

As soon as a transcript finishes — YouTube or podcast — the app saves it to
your Drive automatically as a plain **.txt file**, no button press needed;
by the time you're looking at the transcript on your phone, it's already
backed up. (A **Save to Drive again** button stays in the UI too, for a
manual retry if the auto-save happened to fail.)

This needs a small bridge script, because writing to someone's Drive
normally requires a full Google OAuth client + consent screen (and Google's
"unverified app" refresh tokens expire after 7 days — annoying for a
personal tool). Using a Google Apps Script instead sidesteps all of that: it
runs *as your own Google account*, so no OAuth dance, no verification, no
expiry.

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the placeholder code, paste in the contents of
   `drive-bridge.gs` from this folder.
3. Replace `SHARED_SECRET`'s placeholder value with a long random string
   (this is what stops random people from posting files into your Drive if
   they ever guessed the deployment URL — treat it like a password).
4. **Deploy → New deployment → type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone** (this only controls who can *call* the URL,
     not what it does — it always runs as you, and it always checks the
     secret token before doing anything)
   - Deploy, authorize it when Google prompts (it's your own script asking
     for permission to use your own Drive — normal, one-time).
   - Copy the Web app URL (ends in `/exec`).
5. Back in Cloudflare, add two **secrets** to the Worker (Settings →
   Variables and Secrets, or `npx wrangler secret put NAME` from this
   folder if you're using the CLI alongside Git deploys):
   - `APPS_SCRIPT_URL` — the `/exec` URL from step 4.
   - `APPS_SCRIPT_TOKEN` — the same random string you put in `SHARED_SECRET`.
6. That's it — no folder ID to configure. The script creates a
   **"Transcripts"** folder in your Drive the first time it runs and reuses
   it after. Move, rename, or nest that folder however you like from Drive
   itself later; the script always finds it by name.

If you skip this section, the app still works fine — transcripts just stay
on-screen (copy/download still work) and the auto-save silently reports
Drive isn't connected instead of failing anything else.

## Using it from your phone

- Open that URL in your phone's browser.
- **Add it to your home screen** (Safari: Share → Add to Home Screen;
  Chrome: ⋮ menu → Add to Home Screen) so it opens like an app.
- Paste a YouTube link or an Apple Podcasts episode link, tap **Get
  Transcript**. Podcast episodes take real time to transcribe (a status line
  shows elapsed seconds) — YouTube captions come back almost instantly.
- Toggle **Show timestamps** if you want `[mm:ss]` markers instead of clean
  running text.
- **Copy** puts it straight on your clipboard to paste into Google Docs,
  Notes, Notion, wherever you're drafting. **Download .txt** saves a file
  instead, if your workflow wants a file rather than clipboard text.
- **Drive** (once connected — see above): happens automatically the moment
  the transcript is ready, as a .txt file in your "Transcripts" folder — no
  tap needed. Leave the tab, pick it up later from Drive on any device.

## Pulling out key points and topics

This tool's job stops at getting you a clean transcript — the highest-quality
way to turn that into key points, topics, or a blog/podcast outline is to
hand the transcript to an LLM rather than build bespoke summarization logic
here. For example, paste the transcript into Claude (claude.ai, works fine
on mobile) with a prompt like:

> Here's a video transcript. Pull out the key points and main topics as a
> bulleted outline I can use to write a blog post / podcast script from.
> [paste transcript]

## Limitations

**YouTube:**
- Only works for videos that have **captions available** — either
  creator-uploaded or YouTube's auto-generated ones. No captions, no
  transcript.
- Private, members-only, or age-restricted videos won't work (YouTube
  blocks the page fetch that this relies on).
- Defaults to English captions if available, otherwise falls back to
  whatever's first in the video's caption list. The API response includes
  `availableLanguages` if you want to extend the UI with a language picker
  later.

**Podcasts:**
- **Spotify links don't work, full stop** — no public API or link resolves
  to a downloadable audio file for Spotify-hosted episodes. Use the same
  episode's Apple Podcasts link instead.
- Needs a **specific episode** link (with `?i=...`), not a show link.
- The show has to be indexed by PodcastIndex.org — the vast majority of
  public podcasts are (it's a large, long-running open podcast database),
  but a brand-new or very obscure show could occasionally not be found
  there yet.
- Episode matching relies on comparing Apple's URL slug (a hyphenated,
  sometimes-truncated version of the episode title baked into the link
  itself) against PodcastIndex's episode titles for that show — reliable in
  practice, but a show with very repetitive or near-duplicate episode
  titles could occasionally mismatch. If no confident match is found, it
  fails with a clear error rather than silently transcribing the wrong
  episode.
- Transcription costs real money per hour of audio (AssemblyAI's pricing,
  paid by you via your own API key) and takes real wall-clock time — a
  60-minute episode is not an instant response.
- This scrapes YouTube's public watch-page data (the same technique used by
  most open-source YouTube transcript tools, e.g. `youtube-transcript-api`).
  YouTube doesn't publish this as a stable API, so if they change their page
  structure, `extractPlayerResponse` in `worker.js` may need a small update.
