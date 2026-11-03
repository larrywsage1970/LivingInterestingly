(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const CACHE_KEY = "sgw:last-status";
  const params = new URLSearchParams(location.search);
  const locId = params.get("location");
  const STATIC = document.querySelector('meta[name="sgw-mode"]')?.content === "static";
  // Relative URLs so the same files work at a domain root or under /<repo>/ on GitHub Pages.
  const statusUrl = (refresh) => STATIC
    ? `api/${locId ? `status-${encodeURIComponent(locId)}` : "status"}.json?t=${Date.now()}`
    : `api/${refresh ? "refresh" : "status"}${locId ? `?location=${encodeURIComponent(locId)}` : ""}`;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--";
  const when = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const safeUrl = (u) => /^https:\/\//i.test(u || "") ? u : "#";

  const LABELS = { green: "GREEN · NO ACTIVE ALERTS", amber: "AMBER · ADVISORY / WATCH", red: "RED · WARNING", gray: "GRAY · UNKNOWN" };
  const STATE_TEXT = { fresh: "fresh", stale: "stale", failing: "unavailable", never: "not yet fetched" };

  function feedLine(f) {
    let txt;
    if (f.state === "fresh") txt = `checked ${hhmm(f.last_good_at)}`;
    else if (f.last_good_at) txt = `last good value at ${hhmm(f.last_good_at)}`;
    else txt = "no good data yet";
    return `<div class="feed ${f.state}"><span>${esc(f.label)}</span><span class="st">${STATE_TEXT[f.state]}</span><span>${esc(txt)}</span></div>`;
  }

  function tagFor(it) {
    if (it.kind === "forecast") {
      const h = (it.hazard_mentions || []).length ? `<span class="it-tag warn">mentions ${esc(it.hazard_mentions.join(", "))}</span>` : "";
      return `<span class="it-tag">forecast</span>${h}`;
    }
    if (it.kind === "declaration") {
      return it.active ? `<span class="it-tag warn">active declaration</span>` : `<span class="it-tag">closed declaration</span>`;
    }
    const ev = it.event || "";
    const cls = /Warning$/.test(ev) ? "crit" : /(Watch|Advisory)$/.test(ev) ? "warn" : "";
    return `<span class="it-tag ${cls}">alert · ${esc(it.origin === "ipaws" ? "IPAWS" : "NWS")}</span>`;
  }

  function itemHtml(it, card) {
    const src = card.label;
    const meta = [];
    if (it.kind === "forecast") meta.push(`${when(it.starts)} – ${hhmm(it.ends)}`);
    else {
      if (it.sender) meta.push(esc(it.sender));
      if (it.severity) meta.push(`severity: ${esc(it.severity)}`);
      if (it.issued || it.declared) meta.push(`issued ${when(it.issued || it.declared)}`);
      if (it.ends) meta.push(`until ${when(it.ends)}`);
    }
    return `<li>
      <p class="it-title">${tagFor(it)}${esc(it.title)}</p>
      <p class="it-meta">${meta.join(" · ")}</p>
      <p class="it-meta">Source: ${esc(src)} · fetched ${hhmm(card.last_good_at)}</p>
      ${it.raw_excerpt && it.kind !== "forecast" ? `<p class="it-excerpt">${esc(it.raw_excerpt)}</p>` : ""}
      <a class="src-link" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">Open source ↗</a>
    </li>`;
  }

  function renderLinks(links) {
    const used = new Set();
    $$("[data-links]").forEach((ul) => {
      const key = ul.dataset.links;
      if (key === "*rest") return;
      const mine = links.filter((l) => l.label.includes(key));
      mine.forEach((l) => used.add(l.url));
      ul.innerHTML = mine.map(linkHtml).join("");
    });
    const rest = $("[data-links='*rest']");
    if (rest) rest.innerHTML = links.filter((l) => !used.has(l.url)).map(linkHtml).join("");
  }
  const linkHtml = (l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>${l.verified ? "" : `<span class="unverified">link unverified</span>`}</li>`;

  function render(data, { offline = false } = {}) {
    const loc = data.location, b = data.banner;
    $("#loc-name").textContent = loc.name;
    $("#loc-meta").textContent = `${loc.county} · ${loc.utility} · ${loc.grid_operator}`;
    $("#updated").textContent = `updated ${hhmm(b.computed_at)}`;
    $("#offline").hidden = !offline;

    // The phone checks the snapshot's age itself: if the updater stops, the board turns Gray.
    const ageS = (Date.now() - new Date(b.computed_at).getTime()) / 1000;
    const tooOld = data.stale_after_s && ageS > data.stale_after_s;
    const banner = $("#banner");
    const color = offline || tooOld ? "gray" : b.color;
    banner.className = `banner ${color}`;
    $("#banner-label").textContent = LABELS[color];
    let rule = b.rule + (b.additional_triggers ? ` (+${b.additional_triggers} more)` : "");
    if (offline) rule = `Offline. Last known: ${b.color.toUpperCase()}: ${b.rule}`;
    else if (tooOld) rule = `Unknown: this status is ${Math.round(ageS / 60)} min old, so the updater may be stopped. Last known: ${b.color.toUpperCase()}: ${b.rule}`;
    $("#banner-rule").textContent = rule;

    $$("[data-feeds]").forEach((el) => {
      el.innerHTML = el.dataset.feeds.split(" ").map((id) => data.cards[id]).filter(Boolean).map(feedLine).join("");
    });
    $$("[data-items]").forEach((ul) => {
      const ids = ul.dataset.items.split(" ");
      const html = ids.flatMap((id) => {
        const c = data.cards[id];
        return c ? c.items.map((it) => itemHtml(it, c)) : [];
      });
      const anyUsable = ids.some((id) => data.cards[id]?.last_good_at);
      ul.innerHTML = html.length ? html.join("")
        : `<li class="empty">${anyUsable ? "None reported by the source." : "No data yet. See the source links below."}</li>`;
    });
    renderLinks(loc.links || []);
  }

  async function load(refresh = false) {
    const btn = $("#refresh");
    btn.classList.add("spin");
    try {
      const r = await fetch(statusUrl(refresh), { method: refresh && !STATIC ? "POST" : "GET", cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
      render(data);
    } catch (_) {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (_) {}
      if (cached) render(cached, { offline: true });
      else $("#banner-rule").textContent = "Cannot reach the server and nothing is saved on this device.";
    } finally {
      btn.classList.remove("spin");
    }
  }

  $("#refresh").addEventListener("click", () => load(true));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 120000);
  load();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
