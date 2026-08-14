# YouTube Transcript Extractor

A tiny, self-contained web app: paste a YouTube link, get the transcript,
copy or download it. Built for turning long-form videos into podcast/blog
source material — get the transcript here, then hand it to an LLM (or your
own eyes) to pull out key points and topics.

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

## Connecting Google Drive (auto-save transcripts)

The **Save to Drive** button needs a small bridge script, because writing to
someone's Drive normally requires a full Google OAuth client + consent
screen (and Google's "unverified app" refresh tokens expire after 7 days —
annoying for a personal tool). Using a Google Apps Script instead sidesteps
all of that: it runs *as your own Google account*, so no OAuth dance, no
verification, no expiry.

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
   **"YouTube Transcripts"** folder in your Drive the first time it runs and
   reuses it after. Move, rename, or nest that folder however you like from
   Drive itself later; the script always finds it by name.

Each save creates a real **Google Doc** (not a plain-text file), so it opens
straight into Docs for editing, and Docs' own **File → Download** covers
exporting to PDF, Word (.docx), or plain text — whatever format the next
tool in your podcast/blog workflow actually needs.

If you skip this section, the app still works fine — the **Save to Drive**
button will just report Drive isn't connected instead of failing anything
else.

## Using it from your phone

- Open that URL in your phone's browser.
- **Add it to your home screen** (Safari: Share → Add to Home Screen;
  Chrome: ⋮ menu → Add to Home Screen) so it opens like an app.
- Paste a YouTube link, tap **Get Transcript**.
- Toggle **Show timestamps** if you want `[mm:ss]` markers instead of clean
  running text.
- **Copy** puts it straight on your clipboard to paste into Google Docs,
  Notes, Notion, wherever you're drafting. **Download .txt** saves a file
  instead, if your workflow wants a file rather than clipboard text.
  **Save to Drive** (once connected — see above) drops it straight into your
  "YouTube Transcripts" Drive folder, so you can just leave the tab and pick
  it up later from Drive on any device.

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

- Only works for videos that have **captions available** — either
  creator-uploaded or YouTube's auto-generated ones. No captions, no
  transcript.
- Private, members-only, or age-restricted videos won't work (YouTube
  blocks the page fetch that this relies on).
- Defaults to English captions if available, otherwise falls back to
  whatever's first in the video's caption list. The API response includes
  `availableLanguages` if you want to extend the UI with a language picker
  later.
- This scrapes YouTube's public watch-page data (the same technique used by
  most open-source YouTube transcript tools, e.g. `youtube-transcript-api`).
  YouTube doesn't publish this as a stable API, so if they change their page
  structure, `extractPlayerResponse` in `worker.js` may need a small update.
