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
  // Every time on the page carries its date (e.g. "Nov 3, 11:09 AM").
  const hhmm = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "--";
  const when = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const safeUrl = (u) => /^https:\/\//i.test(u || "") ? u : "#";

  const LABELS = { green: "ALL CLEAR", amber: "HEADS UP", red: "TAKE ACTION", gray: "CAN'T CONFIRM" };

  // ---- Simple view (default): plain words, only notable items ----
  const DETAIL_KEY = "sgw:details";
  let details = false;
  try { details = localStorage.getItem(DETAIL_KEY) === "1"; } catch (_) {}
  const applyMode = () => {
    document.body.classList.toggle("simple", !details);
    const t = $("#detail-toggle");
    if (t) { t.textContent = details ? "Simple view" : "Show details"; t.setAttribute("aria-pressed", String(details)); }
  };
  applyMode();

  /** Items worth showing someone who just wants to know "is anything happening?". */
  function notable(it, id) {
    switch (it.kind) {
      case "alert": return true;
      case "declaration": return !!it.active && !it.national;
      case "spaceweather": return (it.g_scale || 0) >= 4;
      case "nuclear": return /alert|site area|general/i.test(it.emergency_class || "");
      case "airquality": return (it.aqi_category || 0) >= 3;
      case "quake": return ["yellow", "orange", "red"].includes(it.pager) ||
        (it.recent_24h && (it.magnitude || 0) >= 4.5 && (it.distance_km || 999) <= 150);
      case "forecast":
        if (id === "nws_forecast") return true;                 // trimmed separately: now + hazards
        if (it.g_scale !== undefined) return it.g_scale >= 4;
        if (it.aqi_category !== undefined) return it.aqi_category >= 3;
        return true;                                            // SPC outlook only exists when Stow is in a risk area
      default: return false;                                    // CISA, CDC, national declarations: details view only
    }
  }

  function plainStatus(color, b, ageMin, offline) {
    const when = ageMin < 2 ? "just now" : `${Math.round(ageMin)} minutes ago`;
    if (offline) return "No connection right now. Showing the last information saved on this phone.";
    if (color === "gray") return "GRID couldn't reach every official source just now. This is not a warning; it means \"not confirmed\". Tap Refresh, and remember real emergencies still reach your phone as Emergency Alerts.";
    if (color === "green") return `No official emergencies for Stow or Summit County right now. Checked ${when}.`;
    const first = (b.triggers?.[color] || [])[0] || b.rule;
    const what = first.replace(/\s*\((?:[^()]*checked[^()]*)\)\s*$/, "").replace(/^Forecast, not an event:\s*/, "Forecast: ");
    const more = b.additional_triggers ? ` (+${b.additional_triggers} more below)` : "";
    return color === "red" ? `${what}${more}. See "What to do" below.` : `${what}${more}. No immediate action needed. Stay aware and check back.`;
  }
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
    if (it.kind === "spaceweather") {
      const g = it.g_scale || 0;
      return `<span class="it-tag ${g >= 5 ? "crit" : g >= 4 ? "warn" : ""}">space weather · G${g}</span>`;
    }
    if (it.kind === "advisory") return `<span class="it-tag">CISA advisory</span>`;
    if (it.kind === "health") return `<span class="it-tag">CDC notice</span>`;
    if (it.kind === "nuclear") {
      const c = (it.emergency_class || "").toLowerCase();
      const cls = /general|site area/.test(c) ? "crit" : /^alert/.test(c) ? "warn" : "";
      return `<span class="it-tag ${cls}">NRC · ${esc(it.emergency_class || "event report")}</span>`;
    }
    if (it.kind === "airquality") {
      const c = it.aqi_category || 0;
      return `<span class="it-tag ${c >= 6 ? "crit" : c >= 4 ? "warn" : ""}">air quality</span>`;
    }
    if (it.kind === "quake") {
      const cls = ["orange", "red"].includes(it.pager) ? "crit" : it.pager === "yellow" ? "warn" : "";
      return `<span class="it-tag ${cls}">earthquake${it.pager ? " · PAGER " + esc(it.pager) : ""}</span>`;
    }
    if (it.kind === "declaration") {
      return it.active ? `<span class="it-tag warn">active declaration</span>` : `<span class="it-tag">closed declaration</span>`;
    }
    const ev = it.event || "";
    const cls = /Warning$/.test(ev) ? "crit" : /(Watch|Advisory)$/.test(ev) ? "warn" : "";
    const origin = { ipaws: "IPAWS", ntas: "DHS NTAS", nws: "NWS" }[it.origin] || "alert";
    const ntasCls = it.origin === "ntas" ? (/imminent/i.test(it.ntas_type) ? "crit" : /elevated/i.test(it.ntas_type) ? "warn" : "") : cls;
    return `<span class="it-tag ${ntasCls}">alert · ${esc(origin)}</span>`;
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
    // Everything readable here; the source link is small and secondary.
    const parts = [];
    if (it.area) parts.push(`<p class="d-area"><strong>Area:</strong> ${esc(it.area)}</p>`);
    if (it.raw_excerpt) parts.push(`<p>${esc(it.raw_excerpt)}</p>`);
    if (it.instruction) parts.push(`<p class="d-instr"><strong>What to do:</strong> ${esc(it.instruction)}</p>`);
    const details = parts.length
      ? `<details class="more"${it.kind === "alert" ? " open" : ""}><summary>Full details</summary>${parts.join("")}</details>` : "";
    return `<li>
      <p class="it-title">${tagFor(it)}${esc(it.title)}</p>
      <p class="it-meta">${meta.join(" · ")}</p>
      ${details}
      <p class="it-meta src-line">Source: ${esc(src)} · fetched ${hhmm(card.last_good_at)} · <a class="src-mini" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">source ↗</a></p>
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
  const linkHtml = (l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`;

  function render(data, { offline = false } = {}) {
    const loc = data.location, b = data.banner;
    $("#loc-meta").textContent = `${loc.name} · ${loc.county}`;
    $("#updated").textContent = `updated ${hhmm(b.computed_at)}`;
    // Version this page was loaded with vs. the newest published; a mismatch means "reopen".
    const mine = document.querySelector('meta[name="sgw-version"]')?.content || "dev";
    const latest = data.app_version || mine;
    $("#version").textContent = latest !== mine
      ? `version ${mine} · newer version ${latest} available: close and reopen GRID`
      : `version ${mine}`;
    $("#version").classList.toggle("stale-ver", latest !== mine);
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
    $("#banner-plain").textContent = plainStatus(color, b, ageS / 60, offline);

    $$("[data-feeds]").forEach((el) => {
      el.innerHTML = el.dataset.feeds.split(" ").map((id) => data.cards[id]).filter(Boolean).map(feedLine).join("");
    });
    $$("[data-items]").forEach((ul) => {
      const ids = ul.dataset.items.split(" ");
      const recentOnly = ul.dataset.recentOnly === "1";
      const trim = ul.dataset.forecastTrim === "1";
      const lowF = data.location?.forecast_low_amber_f ?? 10;
      let hidden = 0;
      const html = ids.flatMap((id) => {
        const c = data.cards[id];
        if (!c) return [];
        let list = c.items.filter((it) => (!recentOnly || it.recent) && (details || notable(it, id)));
        if (trim && id === "nws_forecast") {
          // Current period always; later periods only when a storm/ice/freeze is in them.
          list = list.filter((it, i) => {
            const keep = i === 0 || (it.hazard_mentions || []).length > 0 || (it.is_low && it.temperature <= lowF);
            if (!keep) hidden++;
            return keep;
          });
        }
        return list.map((it) => itemHtml(it, c));
      });
      if (hidden) html.push(`<li class="empty">${hidden} later forecast period${hidden > 1 ? "s" : ""} hidden: no storms, ice or hard freeze.</li>`);
      const anyUsable = ids.some((id) => data.cards[id]?.last_good_at);
      ul.innerHTML = html.length ? html.join("")
        : `<li class="empty">${anyUsable ? esc(ul.dataset.empty || "None reported by the source.") : "No data yet. See the source links below."}</li>`;
    });
    renderLinks(loc.links || []);

    // Simple view: cards with nothing notable collapse into one calm line.
    const quiet = [];
    $$("main section.card").forEach((card) => {
      const lists = $$("ul.items", card);
      if (!lists.length) return;
      const has = lists.some((ul) => $$("li", ul).some((li) => !li.classList.contains("empty")));
      card.classList.toggle("quiet", !has);
      if (!has) quiet.push(($("h2", card)?.textContent || "").replace(/\s*&\s*/g, " & ").toLowerCase());
    });
    $("#quiet-summary").textContent = quiet.length ? `Nothing active right now: ${quiet.join(", ")}.` : "";
  }

  async function load(refresh = false) {
    const btn = $("#refresh");
    btn.classList.add("spin");
    if (refresh) $("#refresh-label").textContent = "Refreshing…";
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
      if (refresh) {
        $("#refresh-label").textContent = "Updated";
        setTimeout(() => { $("#refresh-label").textContent = "Refresh"; }, 2000);
      }
    }
  }

  // Pull down from the top of the page to refresh (works in the Home Screen app).
  (() => {
    const ptr = $("#ptr");
    let startY = null, pulled = 0;
    window.addEventListener("touchstart", (e) => {
      startY = window.scrollY <= 0 ? e.touches[0].clientY : null; pulled = 0;
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      pulled = Math.max(0, e.touches[0].clientY - startY);
      ptr.style.height = `${Math.min(pulled, 90) * 0.6}px`;
      ptr.textContent = pulled > 80 ? "Release to refresh" : "Pull to refresh";
    }, { passive: true });
    window.addEventListener("touchend", () => {
      if (startY !== null && pulled > 80) refreshNow();
      startY = null; pulled = 0; ptr.style.height = "0px";
    });
  })();

  // Refresh: if the grid-refresh Worker is configured, ask it to check every source now,
  // then watch for the new snapshot (about 1-2 minutes). Otherwise just reload the latest.
  const refreshUrl = document.querySelector('meta[name="sgw-refresh-url"]')?.content || "";
  let checking = false;
  async function refreshNow() {
    if (!STATIC || !/^https:\/\//.test(refreshUrl)) return load(true);
    if (checking) return;
    checking = true;
    const label = $("#refresh-label"), btn = $("#refresh");
    const shown = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null")?.banner?.computed_at; } catch (_) { return null; } };
    btn.classList.add("spin"); label.textContent = "Checking sources…";
    try {
      const r = await fetch(refreshUrl.replace(/\/$/, "") + "/refresh", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Done once the board shows data computed after that update began. For "recent" /
      // "already running" this may already be true, so check right away instead of
      // waiting for an update that is not coming.
      const since = Date.parse(d.started_at || "") || Date.now();
      const fresh = () => { const t = Date.parse(shown() || ""); return t && t >= since; };
      label.textContent = d.action === "started" ? "Checking sources… (1–2 min)" : "Update in progress…";
      await load();
      let done = fresh();
      const deadline = Date.now() + 4 * 60 * 1000;
      while (!done && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 10000));
        await load();
        done = fresh();
      }
      label.textContent = done ? (d.action === "started" ? "Updated" : "Up to date") : "Still waiting: try again shortly";
    } catch (_) {
      await load(true);
      label.textContent = "Reloaded (could not start a new check)";
    } finally {
      btn.classList.remove("spin");
      checking = false;
      setTimeout(() => { label.textContent = "Refresh"; }, 4000);
    }
  }
  $("#refresh").addEventListener("click", refreshNow);
  $("#detail-toggle").addEventListener("click", () => {
    details = !details;
    try { localStorage.setItem(DETAIL_KEY, details ? "1" : "0"); } catch (_) {}
    applyMode();
    try { const d = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (d) render(d); } catch (_) {}
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 120000);
  load();

  // ---- Ask (shown only when an Ask URL is configured) ----
  const askUrl = document.querySelector('meta[name="sgw-ask-url"]')?.content || "";
  if (/^https:\/\//.test(askUrl)) {
    const PASS_KEY = "sgw:ask-pass";
    $("#card-ask").hidden = false;
    try { $("#ask-pass").value = localStorage.getItem(PASS_KEY) || ""; } catch (_) {}
    $$("#ask-chips .chip").forEach((c) => c.addEventListener("click", () => {
      $("#ask-q").value = c.textContent; $("#ask-q").focus();
    }));
    $("#ask-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#ask-q").value.trim(), pass = $("#ask-pass").value;
      const out = $("#ask-out"), go = $("#ask-go");
      if (!q) return;
      go.disabled = true; go.textContent = "…";
      out.innerHTML = `<p class="hint">Checking the primary sources…</p>`;
      try {
        const r = await fetch(askUrl.replace(/\/$/, "") + "/ask", {
          method: "POST", headers: { "Content-Type": "application/json", "X-GRID-Passcode": pass },
          body: JSON.stringify({ question: q }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Ask returned HTTP ${r.status}`);
        try { localStorage.setItem(PASS_KEY, pass); } catch (_) {}
        const src = (data.sources || []).map((s) =>
          `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.name)}</a> · fetched ${esc(hhmm(s.fetched_at))}</li>`).join("");
        out.innerHTML = `<p class="ask-answer">${esc(data.answer)}</p>` +
          (src ? `<p class="it-meta">Sources used:</p><ul class="ask-src">${src}</ul>`
               : `<p class="it-meta">No live source was used for this answer.</p>`);
      } catch (err) {
        out.innerHTML = `<p class="ask-err">${esc(err.message || "Could not reach Ask.")}</p>`;
      } finally {
        go.disabled = false; go.textContent = "Ask";
      }
    });
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
