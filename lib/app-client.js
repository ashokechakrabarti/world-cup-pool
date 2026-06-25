import { TEAMS, TIER_META, STAGES, DEFAULT_SCORING, KICKOFF_ISO } from "./teams.js";
import { entryPoints as entryPointsWith, dailyScore, dailyStats, decidedKoCount, KO_STAGES, gameDateOf, dailyLockFor, winnerByMatchId, goalsByMatchId, ouResult, OU_LINE } from "./scoring.js";   // pure variants for what-if + daily picks

/* ---------------- module state ---------------- */
let CFG = { buyIn: 50, venmoHandle: "", locked: false, scoring: { ...DEFAULT_SCORING } };
let ENTRIES = [];
let MATCHES = [];
let DAILY_PICKS = [];      // [{entryId, matchId, gameDate, winner}] — knockout secondary game
let SCHEDULE = null;       // full feed fixture list (all 104 games, kickoff-ordered) or null pre-sync
let KO_OVERRIDES = {};     // commissioner-set knockout matchups (fixtureId -> {aId,bId}) before the feed
let COMMENTARY_STEER = {}; // commissioner-set booth direction { tone, notes }
let LAST_SYNCED = 0;       // epoch ms of the last successful feed sync
let editMatchId = null;    // commissioner: id of the result row currently being edited (null = adding new)
let picks = {};            // tier -> teamId
let editId = null;         // entry id being edited (null = creating a new entry)
let editCode = "";         // edit code in use for the current edit session
let editCommish = false;   // commissioner override edit (works even when locked)
const CACHE_KEY = "god_edit_v1";   // localStorage: remembers {id, code} on this device for one-click editing
let isCommish = false;
let COMMISH_CODE = "";     // remembered after a successful unlock (never stored server-side in state)
let ME = null;             // entry id of the viewer (this browser), from localStorage — anonymous, local-only
let mePanelOpen = false;   // identity picker dropdown open?
let simEntry = null;       // roster tile currently running a what-if sim (entry id), or null
let simResults = {};       // fixtureId -> "W"|"D"|"L" — hypothetical outcome for this entry's team
let dailyId = null;        // explicit identity chosen for daily picks (overrides the cached edit identity)
let dailyCode = "";        // edit code in use for daily-pick submission
let dailyDraft = {};       // matchId -> teamId — unsaved working winner selections
let dailyAuthOpen = false; // daily-picks identity form expanded?
let NEXT_MATCH = null;     // {status, teamA, teamB, flagA, flagB, when, score} — current/next fixture
let COMMENTARY = null;     // {lines:[{speaker,text}], source} — the booth banter
let lastCommentaryFetch = 0;
let commentaryLoading = false;   // true while a forced "fresh take" is in flight
const KICKOFF = new Date(KICKOFF_ISO);

const teamById = (id) => TEAMS[id];
const tierColor = (t) => TIER_META[t].c;

/* ---------------- API ---------------- */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";   // e.g. "/worldcup2026" — keeps API calls under the app's basePath
async function apiGet() {
  const r = await fetch(`${BASE}/api/state`, { cache: "no-store" });
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
function applyState(s) {
  if (!s || s.error) return false;
  dataLoaded = true;   // state has arrived — modals (and their name picker) can render with real data
  if (s.config) CFG = s.config;
  if (s.entries) ENTRIES = s.entries;
  if (s.matches) MATCHES = s.matches;
  if ("dailyPicks" in s) DAILY_PICKS = s.dailyPicks || [];
  if ("schedule" in s) SCHEDULE = s.schedule;
  if ("koOverrides" in s) KO_OVERRIDES = s.koOverrides || {};
  if ("commentarySteer" in s) COMMENTARY_STEER = s.commentarySteer || {};
  if ("lastSynced" in s) LAST_SYNCED = s.lastSynced || 0;
  if ("nextMatch" in s) NEXT_MATCH = s.nextMatch;
  renderMeChip();
  renderTiers(); renderTicket(); renderRosters(); renderLeaderboard(); renderResults();
  renderDaily();
  applyDailyGate();
  renderDailyNudge();
  renderEditBar();
  renderCommentary();
  if (KICKOFF - new Date() <= 0) renderLiveStrip();
  renderPotNote();
  return true;
}

/* ---------------- scoring ---------------- */
function matchOutcome(m) {
  const out = {};
  if (m.scoreA == null || m.scoreB == null) return out;
  if (m.stage === "group") {
    if (m.scoreA > m.scoreB) { out[m.teamA] = "W"; out[m.teamB] = "L"; }
    else if (m.scoreA < m.scoreB) { out[m.teamA] = "L"; out[m.teamB] = "W"; }
    else { out[m.teamA] = "D"; out[m.teamB] = "D"; }
  } else {
    let w = m.winner;
    if (w == null) { if (m.scoreA > m.scoreB) w = m.teamA; else if (m.scoreB > m.scoreA) w = m.teamB; }
    if (w != null) { out[m.teamA] = w === m.teamA ? "W" : "L"; out[m.teamB] = w === m.teamB ? "W" : "L"; }
  }
  return out;
}
function pointsFor(stage, result) {
  const s = CFG.scoring || DEFAULT_SCORING;
  if (result !== "W" && result !== "D") return 0;
  if (stage === "group") return result === "W" ? s.groupWin : s.groupDraw;
  if (result === "W") return s[stage] || 0;
  return 0;
}
function teamPoints(teamId) {
  let pts = 0;
  for (const m of MATCHES) {
    if (m.teamA !== teamId && m.teamB !== teamId) continue;
    const r = matchOutcome(m)[teamId];
    if (r) pts += pointsFor(m.stage, r);
  }
  return pts;
}
const entryPoints = (e) => e.picks.reduce((a, id) => a + teamPoints(id), 0);

/* ---------------- draft ---------------- */
function renderTiers() {
  const host = document.getElementById("tierList"); if (!host) return; host.innerHTML = "";
  TIER_META.forEach((meta, ti) => {
    const teams = TEAMS.filter((t) => t.tier === ti);
    const el = document.createElement("div"); el.className = "tier";
    el.innerHTML = `
      <div class="tier-head">
        <div class="tier-badge" style="background:${meta.c}">${ti + 1}</div>
        <div class="tier-name">${meta.n}<small>${meta.d}</small></div>
        <div class="tier-pick" id="tp${ti}"></div>
      </div>
      <div class="chips">
        ${teams.map((t) => `<div class="chip ${picks[ti] === t.id ? "sel" : ""} ${CFG.locked ? "lock" : ""}" data-team="${t.id}" data-tier="${ti}">
          <span class="flag">${t.flag}</span><span>${t.name}</span><span class="grp">${t.group}</span>
        </div>`).join("")}
      </div>`;
    host.appendChild(el);
  });
  host.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      if (CFG.locked) return;
      const ti = +c.dataset.tier, id = +c.dataset.team;
      picks[ti] = picks[ti] === id ? undefined : id;
      renderTiers(); renderTicket();
    };
  });
  TIER_META.forEach((m, ti) => {
    const tp = document.getElementById("tp" + ti);
    if (tp) tp.textContent = picks[ti] != null ? "✓ picked" : "choose 1";
  });
}
function renderTicket() {
  const slots = document.getElementById("slots"); if (!slots) return; slots.innerHTML = "";
  let n = 0;
  TIER_META.forEach((meta, ti) => {
    const id = picks[ti];
    if (id != null) {
      n++; const t = teamById(id);
      slots.innerHTML += `<div class="slot filled"><span class="dot" style="background:${meta.c}"></span>
        <span>${t.flag} ${t.name}</span><span class="x" data-tier="${ti}">✕</span></div>`;
    } else {
      slots.innerHTML += `<div class="slot"><span class="dot" style="background:${meta.c};opacity:.4"></span>
        <span>${meta.n} — empty</span></div>`;
    }
  });
  slots.querySelectorAll(".x").forEach((x) => x.onclick = () => { picks[+x.dataset.tier] = undefined; renderTiers(); renderTicket(); });
  document.getElementById("slotCount").textContent = n + " / 6";
  const btn = document.getElementById("submitBtn");
  const note = document.getElementById("payNote");

  if (editId) {   // editing an existing entry — picks only, no name/email/payment
    const lockBlocks = CFG.locked && !editCommish;   // commissioner override ignores the lock
    const ready = n === 6 && !lockBlocks;
    btn.disabled = !ready;
    btn.textContent = editCommish ? "Save Picks (Commissioner)" : "Update Picks";
    note.textContent = lockBlocks ? "Picks are locked." : ready
      ? (editCommish ? "Commissioner override — saving on this player's behalf." : "Save your changes — no new payment needed.")
      : `Pick ${6 - n} more team${6 - n > 1 ? "s" : ""} to continue.`;
    return;
  }

  const name = document.getElementById("inName").value.trim();
  const email = document.getElementById("inEmail").value.trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const ready = n === 6 && name.length > 0 && emailOk && !CFG.locked;
  btn.disabled = !ready;
  if (CFG.locked) { btn.textContent = "Picks are locked"; note.textContent = "The commissioner has locked entries for this pool."; }
  else if (ready) { btn.textContent = `Pay $${CFG.buyIn} & Submit Picks`; note.textContent = `On submit you'll be sent to Venmo to pay $${CFG.buyIn}. Your entry saves immediately; the commissioner marks you paid once it lands.`; }
  else { btn.textContent = `Pay $${CFG.buyIn} & Submit Picks`; note.textContent = n < 6 ? `Pick ${6 - n} more team${6 - n > 1 ? "s" : ""} to continue.` : !name ? "Add your name to continue." : !emailOk ? "Add a valid email to continue." : "Almost there…"; }
}
async function submitEntry() {
  const name = document.getElementById("inName").value.trim();
  const email = document.getElementById("inEmail").value.trim();
  const venmo = document.getElementById("inVenmo").value.trim().replace(/^@/, "");
  const picked = TIER_META.map((_, ti) => picks[ti]);
  if (picked.some((p) => p == null) || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;

  const res = await apiPost("/api/entries", { name, email, venmo, picks: picked });
  if (res.error) { flash(res.error); return; }
  applyState(res);

  const handle = CFG.venmoHandle || venmo || "";
  if (handle) {
    const note = encodeURIComponent("World Cup 2026 — Group of Death buy-in");
    window.open(`https://venmo.com/?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${CFG.buyIn}&note=${note}`, "_blank");
  }
  picks = {};
  document.getElementById("inName").value = "";
  document.getElementById("inEmail").value = "";
  document.getElementById("inVenmo").value = "";
  renderTiers(); renderTicket();

  // Remember this entry on this device so editing later is one click, and show the code once.
  if (res.entryId && res.editCode) {
    cacheEntry(res.entryId, res.editCode);
    renderEditBar();
    alert(`Entry saved!\n\nYour edit code is:  ${res.editCode}\n\nKeep it if you want to change your picks from another device before Thursday. On this device you can just tap "Edit my picks".`);
  }
  flash(handle ? "Entry saved — pay in Venmo, then join WhatsApp below 💸" : "Entry saved!");
}

/* ---------------- self-service pick editing ---------------- */
function cacheEntry(id, code) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ id, code })); } catch (_) {}
}
function getCached() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (_) { return null; }
}
function renderEditBar() {
  const host = document.getElementById("editBar"); if (!host) return;
  if (CFG.locked) {   // post-kickoff: self-service is frozen; point people to the commissioner
    host.innerHTML = `<div class="eb-inner eb-locked">Picks are locked. Message the commissioner on WhatsApp to change yours.</div>`;
    return;
  }
  const cached = getCached();
  const mine = cached && ENTRIES.find((e) => e.id === cached.id);
  host.innerHTML = `<div class="eb-inner">
    <span class="eb-q">Already entered?</span>
    ${mine ? `<button class="btn btn-ghost eb-btn" id="ebMine">Edit my picks (${esc(mine.name)})</button>` : ""}
    <button class="btn btn-ghost eb-btn" id="ebOther">Request a code to edit your picks</button>
    <div class="eb-form" id="ebForm" style="display:none">
      <select id="ebName"><option value="">Select your name…</option>${[...ENTRIES].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select>
      <input id="ebCode" placeholder="Edit code" maxlength="6" style="text-transform:uppercase">
      <button class="btn btn-pay eb-btn" id="ebLoad">Load my picks</button>
    </div>
  </div>`;
  const mineBtn = document.getElementById("ebMine");
  if (mineBtn) mineBtn.onclick = () => beginEdit(cached.id, cached.code);
  document.getElementById("ebOther").onclick = () => {
    const f = document.getElementById("ebForm");
    f.style.display = f.style.display === "none" ? "flex" : "none";
  };
  document.getElementById("ebLoad").onclick = () => {
    const id = document.getElementById("ebName").value;
    const code = document.getElementById("ebCode").value.trim().toUpperCase();
    if (!id) return flash("Pick your name");
    if (!code) return flash("Enter your edit code");
    beginEdit(id, code);
  };
}
async function beginEdit(id, code) {
  const res = await apiPost("/api/entries/edit", { entryId: id, editCode: code, mode: "lookup" });
  if (res.error) { flash(res.error); return; }
  editId = id; editCode = code;
  cacheEntry(id, code);   // remember for next time on this device
  picks = {};
  (res.picks || []).forEach((teamId) => { const t = TEAMS[teamId]; if (t) picks[t.tier] = teamId; });
  const ent = ENTRIES.find((e) => e.id === id);
  document.getElementById("draftHead").textContent = "Edit your picks";
  document.getElementById("draftLead").textContent = ent ? `Updating ${ent.name}'s squad. Change any tier, then save.` : "Change any tier, then save.";
  document.getElementById("newFields").style.display = "none";
  document.getElementById("cancelEditBtn").style.display = "";
  // the edit bar lives on the Rosters tab — jump to Draft to actually change picks
  showTab("draft");
  renderTiers(); renderTicket();
  document.getElementById("draftHead").scrollIntoView({ behavior: "smooth", block: "start" });
}
function cancelEdit() {
  editId = null; editCode = ""; editCommish = false; picks = {};
  document.getElementById("draftHead").textContent = "Make your picks";
  document.getElementById("draftLead").textContent = "One team per tier, six total. Tiers are set by tournament-winner odds — everyone gets one favorite and one prayer.";
  document.getElementById("newFields").style.display = "";
  document.getElementById("cancelEditBtn").style.display = "none";
  renderTiers(); renderTicket();
}
// Commissioner edits a player's picks directly — preload from known state, no edit code or lock check.
function beginCommishEdit(id) {
  const ent = ENTRIES.find((e) => e.id === id); if (!ent) return;
  editId = id; editCommish = true; editCode = "";
  picks = {};
  (ent.picks || []).forEach((teamId) => { const t = TEAMS[teamId]; if (t) picks[t.tier] = teamId; });
  document.getElementById("draftHead").textContent = "Edit picks (Commissioner)";
  document.getElementById("draftLead").textContent = `Updating ${ent.name}'s squad on their behalf. Works even while the pool is locked.`;
  document.getElementById("newFields").style.display = "none";
  document.getElementById("cancelEditBtn").style.display = "";
  // jump to the Draft tab (works even when the tab is greyed out for players)
  showTab("draft");
  renderTiers(); renderTicket();
  document.getElementById("draftHead").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function updatePicks() {
  const picked = TIER_META.map((_, ti) => picks[ti]);
  if (picked.some((p) => p == null)) return;
  const res = editCommish
    ? await apiPost("/api/admin", { action: "editPicks", code: COMMISH_CODE, id: editId, picks: picked })
    : await apiPost("/api/entries/edit", { entryId: editId, editCode, picks: picked });
  if (res.error) { flash(res.error); return; }
  const wasCommish = editCommish;
  applyState(res);
  cancelEdit();
  if (wasCommish) renderAdmin();
  flash("Picks updated ✅");
}

/* ---------------- rosters / leaderboard / results ---------------- */
function teamMini(id) { const t = teamById(id); return `<span class="mini"><span class="tb" style="background:${tierColor(t.tier)}"></span>${t.flag} ${t.name}</span>`; }
function shortDate(iso) {
  try { return new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(iso)); }
  catch { return ""; }
}
// A team's group-stage timeline for the roster: each played game as a W/D/L scoreline chip
// (from the team's perspective), the live game if one's on, and the single next fixture.
function teamTimelineChips(id) {
  if (!SCHEDULE) return "";
  const byKey = {};
  for (const m of MATCHES) byKey[stageKey(m.stage, m.teamA, m.teamB)] = m;
  const fixtures = SCHEDULE
    .filter((f) => f.aId === id || f.bId === id)
    .sort((a, b) => Date.parse(a.utcDate || 0) - Date.parse(b.utcDate || 0));
  const chips = [];
  let nextShown = false;
  for (const f of fixtures) {
    const oppId = f.aId === id ? f.bId : f.aId;
    const opp = teamById(oppId)?.name || "?";
    const m = byKey[stageKey(f.stage, f.aId, f.bId)];
    if (m && m.scoreA != null && m.scoreB != null) {
      const mine = m.teamA === id ? m.scoreA : m.scoreB;
      const theirs = m.teamA === id ? m.scoreB : m.scoreA;
      const r = matchOutcome(m)[id];
      const cls = r === "W" ? "win" : r === "D" ? "draw" : "loss";
      chips.push(`<span class="rchip ${cls}" title="${esc(opp)} ${mine}-${theirs}">${mine}-${theirs}</span>`);
    } else if (f.status === "IN_PLAY" || f.status === "PAUSED" || f.status === "LIVE") {
      const sc = f.scoreA != null && f.scoreB != null ? ` ${f.aId === id ? f.scoreA : f.scoreB}-${f.aId === id ? f.scoreB : f.scoreA}` : "";
      chips.push(`<span class="rchip live" title="Live vs ${esc(opp)}">LIVE${sc}</span>`);
    } else if (!nextShown && f.aId != null && f.bId != null) {
      nextShown = true;
      chips.push(`<span class="rchip next" title="Next: vs ${esc(opp)}">${shortDate(f.utcDate)} v ${esc(opp)}</span>`);
    }
  }
  return chips.join("");
}
// One expanded roster line per drafted team: tier badge, name + group, result chips, points earned.
function rosterTeamRow(id) {
  const t = teamById(id);
  return `<div class="rteam">
    <div class="rteam-head">
      <span class="rteam-tier"><i style="background:${tierColor(t.tier)}"></i>T${t.tier + 1}</span>
      <span class="rteam-name">${t.flag} ${esc(t.name)}<span class="rteam-grp">Grp ${esc(t.group)}</span></span>
      <span class="rteam-pts">${teamPoints(id)}</span>
    </div>
    <div class="rteam-chips">${teamTimelineChips(id)}</div>
  </div>`;
}
/* ---------------- identity ("who are you?") ---------------- */
function loadMe() { try { const v = localStorage.getItem("wc-me"); return v == null || v === "" ? null : v; } catch { return null; } }
function saveMe(id) { try { if (id == null) localStorage.removeItem("wc-me"); else localStorage.setItem("wc-me", String(id)); } catch {} }
function meEntry() { return ME == null ? null : ENTRIES.find((e) => e.id === ME) || null; }

function renderMeChip() {
  const host = document.getElementById("meChip"); if (!host) return;
  const me = meEntry();
  // If a stored identity no longer matches any entry (e.g. deleted), forget it.
  if (ME != null && !me) { ME = null; saveMe(null); }
  const trigger = me
    ? `<button type="button" class="me-pill set" id="meBtn">🙋 You're <b>${esc(me.name)}</b></button><button type="button" class="me-change" id="meChange">change</button>`
    : `<button type="button" class="me-pill" id="meBtn">🙋 Who are you?</button>`;
  let panel = "";
  if (mePanelOpen) {
    const opts = [...ENTRIES].sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `<button type="button" class="me-opt${e.id === ME ? " cur" : ""}" data-me="${e.id}">${esc(e.name)}</button>`).join("");
    panel = `<div class="me-panel"><div class="me-panel-h">Tap your name — saved on this device only</div>
      <div class="me-opts">${opts || '<div class="me-empty">No entries yet.</div>'}</div>
      ${me ? `<button type="button" class="me-opt clear" data-me="">Not me / clear</button>` : ""}</div>`;
  }
  host.innerHTML = `<div class="me-row">${trigger}</div>${panel}`;
  const btn = document.getElementById("meBtn");
  if (btn) btn.onclick = () => { mePanelOpen = !mePanelOpen; renderMeChip(); };
  const chg = document.getElementById("meChange");
  if (chg) chg.onclick = () => { mePanelOpen = true; renderMeChip(); };
  host.querySelectorAll("[data-me]").forEach((b) => b.onclick = () => {
    const v = b.dataset.me;
    ME = v === "" ? null : v;
    saveMe(ME);
    mePanelOpen = false;
    renderMeChip(); renderRosters(); renderLeaderboard();
  });
}

/* ---------------- nemesis (your closest rival) ---------------- */
function computeNemesis(meId) {
  const me = ENTRIES.find((e) => e.id === meId); if (!me || ENTRIES.length < 2) return null;
  const myPts = entryPoints(me);
  const mySet = new Set(me.picks);
  let best = null;
  for (const o of ENTRIES) {
    if (o.id === meId) continue;
    const shared = o.picks.filter((id) => mySet.has(id));
    const weighted = shared.reduce((a, id) => a + (teamById(id).tier <= 1 ? 2 : 1), 0);   // Tier 1-2 count double
    const proximity = Math.max(0, 8 - Math.abs(entryPoints(o) - myPts));                   // closer on the table = hotter
    const score = weighted * 3 + proximity;
    if (!best || score > best.score || (score === best.score && shared.length > best.shared.length)) {
      best = { o, score, shared, weighted };
    }
  }
  return best;
}
function nextSharedMatch(sharedIds) {
  if (!SCHEDULE || !sharedIds.length) return null;
  const set = new Set(sharedIds);
  return SCHEDULE
    .filter((g) => g.status !== "FINISHED" && (set.has(g.aId) || set.has(g.bId)))
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))[0] || null;
}
function nemesisHTML() {
  if (ME == null) return "";
  const n = computeNemesis(ME);
  if (!n) return "";
  const overlap = n.shared.length;
  const phrase = overlap ? `you overlap on <b>${overlap}/6</b> teams` : `you're neck-and-neck on the table`;
  let watch = "";
  const m = nextSharedMatch(n.shared);
  if (m) {
    const set = new Set(n.shared);
    const mine = set.has(m.aId) ? { name: m.teamA, flag: m.flagA, opp: m.teamB } : { name: m.teamB, flag: m.flagB, opp: m.teamA };
    watch = ` — watch <b>${esc(mine.flag || "")} ${esc(mine.name)}</b> vs ${esc(mine.opp)}`;
  }
  return `<div class="nemesis"><span class="nemesis-tag">⚔️ Your Nemesis</span>
    <span class="nemesis-txt"><b>${esc(n.o.name)}</b> — ${phrase}${watch}.</span></div>`;
}

function renderRosters() {
  const host = document.getElementById("rosterList"); if (!host) return;
  if (!ENTRIES.length) { host.innerHTML = emptyBox("No entries yet", "Be the first to draft a squad."); return; }
  const sorted = [...ENTRIES].sort((a, b) => a.createdAt - b.createdAt);
  host.innerHTML = `<div class="card">${sorted.map((e) => `
    <div class="row${e.id === ME ? " is-me" : ""}${simEntry === e.id ? " simming" : ""}" style="align-items:flex-start">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:9px">
          <span class="pname">${esc(e.name)}</span>
          ${e.id === ME ? `<span class="badge you">you</span>` : ""}
          <span class="badge ${e.paid ? "paid" : "unpaid"}">${e.paid ? "paid" : "unpaid"}</span>
        </div>
        ${e.venmo ? `<div class="pmeta">@${esc(e.venmo)}</div>` : ""}
        <div class="rteams">${e.picks.map(rosterTeamRow).join("")}</div>
        ${e.id === ME ? nemesisHTML() : ""}
        ${simPanelHTML(e)}
      </div>
      <div class="pts">${ptsCellHTML(e)}</div>
    </div>`).join("")}</div>`;

  host.querySelectorAll("[data-sim]").forEach((b) => b.onclick = () => {
    simEntry = simEntry === b.dataset.sim ? null : b.dataset.sim;
    simResults = {};
    renderRosters();
  });
  host.querySelectorAll("[data-simfx]").forEach((b) => b.onclick = () => {
    const fid = b.dataset.simfx, val = b.dataset.simval;
    if (simResults[fid] === val) delete simResults[fid];   // tap again to clear
    else simResults[fid] = val;
    renderRosters();
  });
}
function renderLeaderboard() {
  const host = document.getElementById("lbList"); if (!host) return;
  if (!ENTRIES.length) { host.innerHTML = emptyBox("Nothing to rank yet", "Standings appear once people draft and games are played."); return; }
  // Daily-picks sub-score breaks ties on main points (then name, for determinism).
  const ranked = [...ENTRIES]
    .map((e) => ({ e, p: entryPoints(e), d: SCHEDULE ? dailyScore(e.id, DAILY_PICKS, SCHEDULE, MATCHES) : 0 }))
    .sort((a, b) => b.p - a.p || b.d - a.d || a.e.name.localeCompare(b.e.name));
  const anyDaily = ranked.some((r) => r.d > 0);
  const rows = ranked.map((r, i) => `
    <div class="row${r.e.id === ME ? " is-me" : ""}">
      <div class="rank ${i < 3 ? "r" + (i + 1) : ""}">${i + 1}</div>
      <div style="flex:1">
        <div class="pname">${esc(r.e.name)} ${r.e.id === ME ? '<span class="badge you" style="margin-left:6px">you</span>' : ""} ${r.e.paid ? "" : '<span class="badge unpaid" style="margin-left:6px">unpaid</span>'}</div>
        <div class="teamline">${r.e.picks.map(teamMini).join("")}</div>
        ${anyDaily ? `<div class="daily-sub" title="Daily knockout picks — tiebreaker">🎯 ${r.d} daily pick${r.d === 1 ? "" : "s"} correct</div>` : ""}
      </div>
      <div class="pts"><b>${r.p}</b><small>points</small></div>
    </div>`).join("");
  const nem = nemesisHTML();
  host.innerHTML = (nem ? `<div class="lb-nemesis-wrap">${nem}</div>` : "") + rows;
  maybeConfetti(ranked);
}

/* ---------------- confetti when your rank climbs ---------------- */
let _confetti = null;
async function fireConfetti() {
  try {
    if (!_confetti) _confetti = (await import("canvas-confetti")).default;
    _confetti({ particleCount: 90, spread: 72, origin: { y: 0.6 }, zIndex: 9999 });
    setTimeout(() => _confetti({ particleCount: 55, angle: 60, spread: 55, origin: { x: 0 }, zIndex: 9999 }), 140);
    setTimeout(() => _confetti({ particleCount: 55, angle: 120, spread: 55, origin: { x: 1 }, zIndex: 9999 }), 280);
  } catch (_) {}
}
function maybeConfetti(ranked) {
  if (ME == null) return;
  const idx = ranked.findIndex((r) => r.e.id === ME);
  if (idx < 0) return;
  const rank = idx + 1;
  const key = "wc-rank-" + ME;
  let prev = null;
  try { const v = localStorage.getItem(key); prev = v == null ? null : Number(v); } catch {}
  try { localStorage.setItem(key, String(rank)); } catch {}
  if (prev != null && rank < prev) fireConfetti();   // climbed since last view → celebrate
}

/* ---------------- daily picks: tab reveal + explainer modals ---------------- */
// Two one-time overlays lead into the game: a "coming soon" TEASER starting 5 days before the first
// knockout, then a confetti LAUNCH modal once picks open (2 days before, when the tab unlocks).
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_REVEAL_MS = 2 * DAY_MS;    // tab unlocks / picks open this far before the first knockout
const TEASER_START_AT = Date.parse("2026-06-22T04:00:00Z");   // 9:00 PM PT, Jun 21 2026 — teaser goes live tonight
const TEASER_MAX_VIEWS = 3;            // stop showing the teaser after this many appearances
// Earliest knockout kickoff in the schedule (epoch ms), or null if none are scheduled yet.
function knockoutStart() {
  if (!SCHEDULE) return null;
  let earliest = null;
  for (const f of SCHEDULE) {
    if (!KO_STAGES.has(f.stage) || !f.utcDate) continue;
    const t = Date.parse(f.utcDate);
    if (!Number.isNaN(t) && (earliest == null || t < earliest)) earliest = t;
  }
  return earliest;
}
// True once the knockout bracket starts resolving — i.e. at least one knockout matchup has both
// teams set. That opens the Daily Picks tab so finalized matchups become pickable as soon as the
// teams are known, and keeps it open through (and after) the knockouts so results stay visible.
// Each day's slate is still editable until it locks at its first kickoff (dailyLockFor).
function dailyRevealed() {
  if (!SCHEDULE) return false;
  return SCHEDULE.some((f) => KO_STAGES.has(f.stage) && f.aId != null && f.bId != null);
}
// True in the heads-up window: from the scheduled teaser start until picks open (the launch
// reveal). Driven by an absolute start time so it can run before the knockout bracket is drawn.
function dailyTeaserActive() {
  return Date.now() >= TEASER_START_AT && !dailyRevealed();
}
// Human countdown to when picks open (the tab unlock), e.g. "3 days", "tomorrow", "today".
function daysUntilOpen() {
  const ks = knockoutStart(); if (ks == null) return "soon";
  const d = Math.ceil((ks - DAILY_REVEAL_MS - Date.now()) / DAY_MS);
  if (d <= 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}
// Commissioners get the tab early (to preview and seed); players see it only once it's revealed.
function dailyVisible() { return isCommish || dailyRevealed(); }
let dataLoaded = false;   // true once /api/state has populated ENTRIES etc. — guards modal rendering
function applyDailyGate() {
  const btn = document.querySelector('nav.tabs button[data-tab="daily"]');
  if (btn) btn.classList.toggle("tab-hidden", !dailyVisible());
  // If a player is parked on a Daily tab that just hid, bounce them somewhere visible.
  if (!dailyVisible()) {
    const sec = document.getElementById("daily");
    if (sec && sec.classList.contains("show")) showTab(started() ? "leaderboard" : "draft");
  }
  // Don't fire the explainer modals until state has loaded — otherwise the teaser builds its name
  // picker from an empty ENTRIES list (the modal won't rebuild once data arrives).
  if (!dataLoaded) return;
  if (dailyRevealed()) maybeDailyModal("launch");
  else if (dailyTeaserActive()) maybeDailyModal("teaser");
}

let nudgeDismissed = false;   // hide the reminder banner for the rest of this visit once ✕'d
// Lightweight always-on reminder: nudge people to the open slate before it locks. Hidden when
// picks aren't open, when they're already on the Daily tab, when they've picked every open-day
// game, or once dismissed this session.
function renderDailyNudge() {
  const host = document.getElementById("dailyNudge"); if (!host) return;
  const onDaily = document.getElementById("daily")?.classList.contains("show");
  if (!dailyRevealed() || nudgeDismissed || onDaily) { host.innerHTML = ""; return; }
  const now = Date.now();
  const open = dailySlate().find((d) => d.lock == null || now < d.lock);   // earliest still-open day
  if (!open) { host.innerHTML = ""; return; }
  // Who's looking? Prefer the daily-picks identity, fall back to the self-ID. If we know them and
  // they've already picked a winner for every game that day, don't nag.
  const who = dailyId != null ? dailyId : ME;
  if (who != null) {
    const picked = new Set(DAILY_PICKS.filter((p) => p.entryId === who).map((p) => p.matchId));
    if (open.fixtures.every((f) => picked.has(f.id))) { host.innerHTML = ""; return; }
  }
  // Lock = the day's first kickoff. Only say "today" when the open slate is actually today (PT);
  // otherwise name the day so a banner about Sunday's games doesn't claim they lock "today".
  const isToday = open.gameDate === gameDateOf(new Date().toISOString());
  const lockTxt = open.lock != null ? fmtMatchTime(new Date(open.lock).toISOString()) : null;
  const txt = isToday
    ? (lockTxt
        ? `⏰ Today's knockout games lock at <b>${esc(lockTxt)}</b>, the minute the first match kicks off — lock in your winners &amp; O/U.`
        : `⏰ Today's knockout games lock at the first kickoff — lock in your winners &amp; O/U.`)
    : (lockTxt
        ? `⏰ Next up — <b>${esc(fmtDailyDate(open.gameDate))}</b>. Picks lock at <b>${esc(lockTxt)}</b> when the first match kicks off, so get yours in.`
        : `⏰ Next up — <b>${esc(fmtDailyDate(open.gameDate))}</b>. Picks lock when the first match kicks off, so get yours in.`);
  host.innerHTML = `<div class="dnudge">
    <span class="dnudge-txt">${txt}</span>
    <button class="btn btn-pay dnudge-go" id="dnudgeGo" type="button">Make my picks</button>
    <button class="dnudge-x" id="dnudgeX" type="button" aria-label="Dismiss">✕</button>
  </div>`;
  document.getElementById("dnudgeGo").onclick = () => showTab("daily");
  document.getElementById("dnudgeX").onclick = () => { nudgeDismissed = true; host.innerHTML = ""; };
}

// Shared body for both explainer modals: the premise, how to play, and an Over/Under primer.
function dailyModalBody(mode) {
  const live = mode === "launch";
  return `<div class="dp-modal dpm">
    <div class="dpm-band">
      <button class="dpm-close" id="dpModalClose" type="button" aria-label="Close">✕</button>
      <div class="dpm-kicker">⚽ World Cup 2026 Pool</div>
      <div class="dpm-title">Daily Picks</div>
      <div class="dpm-sub">${live ? "Now live! ⚽" : `Kicks off ${esc(daysUntilOpen())}`}</div>
    </div>
    <div class="dpm-body">
      <p class="dpm-lead">A second game — and a <b>second pot</b> — for the knockout rounds. Everyone plays, even if your drafted squad is already booking flights home.</p>
      <div class="dpm-sec">
        <div class="dpm-sec-h">How to play</div>
        <ul class="dpm-list">
          <li>Each game day, tap the <b>winner</b> of every knockout match — <b>$1 a pick</b> into the pot.</li>
          <li>Want extra credit? Add an optional <b>Over/Under</b> call on total goals — free, no extra charge.</li>
          <li><b>Lock</b> your picks before that day's first kickoff — then come back the next day for the next slate.</li>
        </ul>
      </div>
      <div class="dpm-sec">
        <div class="dpm-sec-h">Why bother</div>
        <p>It's a <b>winner-takes-all pot</b>: most correct picks by the final whistle takes the cash — a separate game from the main pool, so you're still playing for money even after your squad's out. Bonus: your daily record also <b>breaks ties</b> on the main leaderboard.</p>
      </div>
      <div class="dpm-ou">
        <div class="dpm-ou-h">⚽ What's "O/U"?</div>
        <p><b>Over/Under</b> is a call on the <b>total goals</b> both teams score in a match. We post a line — say <b>2.5</b>. Think it'll be a shootout? Take the <b>Over</b>. Reckon it's a tight, cagey affair? Take the <b>Under</b>. The half-goal line means there's never a tie — and the number comes straight from the sportsbooks.</p>
      </div>
    </div>
    ${(live || ME != null) ? "" : `<div class="dpm-namepick" id="dpmNamePick">
      <label class="dpm-name-lab" for="dpmName">Optional — tap your name so the commissioner can check you off:</label>
      <select id="dpmName" class="dpm-name-sel"><option value="">Select your name…</option>${[...ENTRIES].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select>
    </div>`}
    <button class="btn btn-pay dpm-cta" id="dpModalCta">${live ? "Make my picks" : "I'll be ready"}</button>
  </div>`;
}
let teaserDismissedThisSession = false;   // don't re-pop the teaser within one visit (e.g. on poll refresh)
// Launch shows once per browser (confetti). Teaser shows up to TEASER_MAX_VIEWS times across visits
// and stops for good once acknowledged via "I'll be ready" (which also logs a read for the player).
// opts.preview (commissioner "try it out"): bypass all the gates and never record anything.
function maybeDailyModal(mode, opts = {}) {
  const preview = !!opts.preview;
  const isTeaser = mode === "teaser";
  const seenKey = mode === "launch" ? "wc-daily-launch-seen" : "wc-daily-teaser-seen";
  const countKey = "wc-daily-teaser-count";
  if (!preview) {
    if (isTeaser && teaserDismissedThisSession) return;
    try {
      if (localStorage.getItem(seenKey)) return;                                              // acknowledged — done for good
      if (isTeaser && Number(localStorage.getItem(countKey) || 0) >= TEASER_MAX_VIEWS) return; // shown enough times
    } catch (_) {}
  }
  if (document.getElementById("dpModal")) return;
  if (isTeaser && !preview) {   // count this appearance toward the cap
    try { localStorage.setItem(countKey, String(Number(localStorage.getItem(countKey) || 0) + 1)); } catch (_) {}
  }
  const bg = document.createElement("div");
  bg.className = "dp-modal-bg"; bg.id = "dpModal";
  bg.innerHTML = dailyModalBody(mode);
  // ✕ / backdrop: launch marks itself seen (once-per-browser); teaser just spends one appearance
  // (so it can return next visit until the cap) and won't re-pop again this session.
  const dismiss = () => {
    if (isTeaser) teaserDismissedThisSession = true;
    closeDailyModal(preview || isTeaser ? null : seenKey, false);
  };
  bg.addEventListener("click", (e) => { if (e.target === bg) dismiss(); });
  document.body.appendChild(bg);
  const x = document.getElementById("dpModalClose");
  if (x) x.onclick = dismiss;

  const cta = document.getElementById("dpModalCta");
  cta.onclick = () => {
    if (!isTeaser || preview) { closeDailyModal(preview ? null : seenKey, !preview && mode === "launch"); return; }
    // Teaser "I'll be ready" ALWAYS dismisses (and won't show again). If we know who they are —
    // from the self-ID or the optional name picker — log a read; otherwise just close cleanly.
    let id = ME;
    if (id == null) {
      const sel = document.getElementById("dpmName");
      if (sel && sel.value) { id = sel.value; ME = id; saveMe(ME); renderMeChip(); }
    }
    if (id != null) logTeaserRead(id);
    teaserDismissedThisSession = true;
    try { localStorage.setItem(seenKey, "1"); } catch (_) {}
    closeDailyModal(null, false);
  };

  lockScroll();   // freeze the page behind the overlay (esp. mobile: stop background scroll bleed)
  if (mode === "launch") fireConfetti();
}
// Tell the server this player acknowledged the teaser — surfaces as "read" in the commissioner tab.
function logTeaserRead(entryId) {
  if (entryId == null) return;
  try { apiPost("/api/teaser-read", { entryId }); } catch (_) {}   // fire-and-forget; never blocks the UI
}
function closeDailyModal(key, goToTab) {
  if (key) { try { localStorage.setItem(key, "1"); } catch (_) {} }
  const bg = document.getElementById("dpModal"); if (bg) bg.remove();
  unlockScroll();
  if (goToTab) showTab("daily");
}
// Body scroll-lock for overlays. position:fixed (not just overflow:hidden) is the reliable way to
// stop iOS Safari from scrolling the page behind a modal; we stash and restore the scroll position.
let scrollLockY = 0;
function lockScroll() {
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  const b = document.body.style;
  b.position = "fixed"; b.top = `-${scrollLockY}px`; b.left = "0"; b.right = "0"; b.width = "100%";
}
function unlockScroll() {
  const b = document.body.style;
  b.position = ""; b.top = ""; b.left = ""; b.right = ""; b.width = "";
  window.scrollTo(0, scrollLockY);
}

/* ---------------- what-if simulator (group stage only) ---------------- */
// Unplayed group fixtures (from the feed schedule) that feature one of this entry's teams.
function simFixtures(entry) {
  if (!SCHEDULE) return [];
  const manual = new Set(MATCHES.map((m) => stageKey(m.stage, m.teamA, m.teamB)));
  const mine = new Set(entry.picks);
  const seen = new Set();
  const out = [];
  for (const f of SCHEDULE) {
    if (f.stage !== "group" || f.aId == null || f.bId == null) continue;
    if (f.status === "FINISHED") continue;
    if (manual.has(stageKey("group", f.aId, f.bId))) continue;   // already has a real result
    const myTeam = mine.has(f.aId) ? f.aId : mine.has(f.bId) ? f.bId : null;
    if (myTeam == null || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ f, myTeam });
  }
  return out.sort((a, b) => new Date(a.f.utcDate) - new Date(b.f.utcDate));
}
// Synthesize hypothetical match rows from the current sim selections, oriented to the entry's team.
function simMatches(entry) {
  const manual = new Set(MATCHES.map((m) => stageKey(m.stage, m.teamA, m.teamB)));
  const out = [];
  for (const [fid, outcome] of Object.entries(simResults)) {
    const fx = SCHEDULE && SCHEDULE.find((f) => String(f.id) === String(fid));
    if (!fx || fx.aId == null || fx.bId == null) continue;
    if (manual.has(stageKey("group", fx.aId, fx.bId))) continue;   // a real result landed since selecting
    const myIsA = entry.picks.includes(fx.aId);
    let sa, sb;
    if (outcome === "D") { sa = 1; sb = 1; }
    else if (outcome === "W") { if (myIsA) { sa = 1; sb = 0; } else { sa = 0; sb = 1; } }
    else { if (myIsA) { sa = 0; sb = 1; } else { sa = 1; sb = 0; } }
    out.push({ stage: "group", teamA: fx.aId, teamB: fx.bId, scoreA: sa, scoreB: sb });
  }
  return out;
}
// Points cell — shows a live total, or an amber projection while simulating.
function ptsCellHTML(e) {
  const live = entryPoints(e);
  if (simEntry === e.id && Object.keys(simResults).length) {
    const proj = entryPointsWith(e, [...MATCHES, ...simMatches(e)], CFG.scoring || DEFAULT_SCORING);
    if (proj !== live) return `<b class="proj">${proj}</b><small class="proj-lab">projected</small>`;
  }
  return `<b>${live}</b><small>pts</small>`;
}
function simPanelHTML(e) {
  const fx = simFixtures(e);
  const active = simEntry === e.id;
  if (!fx.length && !active) return "";   // nothing to simulate → no control
  let html = `<div class="sim-bar"><button type="button" class="sim-toggle${active ? " on" : ""}" data-sim="${e.id}">${active ? "Done" : "🔮 What if?"}</button>`;
  if (active) html += `<span class="sim-hint">Tap an outcome for each upcoming group game</span>`;
  html += `</div>`;
  if (!active) return html;
  const rows = fx.map(({ f, myTeam }) => {
    const t = teamById(myTeam);
    const opp = teamById(f.aId === myTeam ? f.bId : f.aId);
    const cur = simResults[f.id] || "";
    const btn = (val, lab) => `<button type="button" class="sim-o sim-${val.toLowerCase()}${cur === val ? " sel" : ""}" data-simfx="${f.id}" data-simval="${val}">${lab}</button>`;
    return `<div class="sim-row">
      <span class="sim-team">${t.flag} ${esc(t.name)} <span class="sim-vs">v</span> ${opp.flag} ${esc(opp.name)}</span>
      <span class="sim-opts">${btn("W", "Win")}${btn("D", "Draw")}${btn("L", "Loss")}</span>
    </div>`;
  }).join("");
  html += `<div class="sim-panel">${rows || '<div class="sim-empty">No upcoming group games for this squad.</div>'}</div>`;
  return html;
}

/* ---------------- commentary booth ---------------- */
const BOOTH_META = {
  Ron:  { emoji: "🎙️", who: 'Ron "The Gaffer" Beaumont', cls: "booth-ron" },
  Chaz: { emoji: "📣", who: "Chaz Pemberton", cls: "booth-chaz" },
};
async function renderCommentary(force) {
  const host = document.getElementById("commentary"); if (!host) return;
  const now = Date.now();
  if (!force && COMMENTARY && now - lastCommentaryFetch < 20000) { paintCommentary(); return; }
  if (commentaryLoading) return;        // a fresh take is already in flight
  if (force) commentaryLoading = true;  // keep the old lines but show the button working
  if (!COMMENTARY || force) paintCommentary();
  lastCommentaryFetch = now;
  try {
    const r = await fetch(`${BASE}/api/commentary${force ? "?force=1" : ""}`, { cache: "no-store" });
    const data = await r.json();
    if (data && Array.isArray(data.lines) && data.lines.length) COMMENTARY = data;
  } catch (_) {}
  finally { commentaryLoading = false; paintCommentary(); }
}
function boothHead() {
  const label = commentaryLoading ? "Fresh take…" : "↻ Fresh take";
  return `<div class="booth-head"><span class="booth-tag">🎧 In the booth</span>
    <button type="button" class="booth-refresh" id="boothRefresh"${commentaryLoading ? " disabled" : ""}>${label}</button></div>`;
}
function paintCommentary() {
  const host = document.getElementById("commentary"); if (!host) return;
  if (!COMMENTARY || !COMMENTARY.lines || !COMMENTARY.lines.length) {
    host.innerHTML = `${boothHead()}
      <div class="booth-line booth-ron"><span class="booth-av">🎙️</span><div class="booth-bubble"><span class="booth-name">Ron "The Gaffer" Beaumont</span><span class="booth-text">Mics on, Chaz — give us a sec to read the table…</span></div></div>`;
  } else {
    const rows = COMMENTARY.lines.map((l) => {
      const m = BOOTH_META[l.speaker] || BOOTH_META.Ron;
      return `<div class="booth-line ${m.cls}">
        <span class="booth-av">${m.emoji}</span>
        <div class="booth-bubble"><span class="booth-name">${esc(m.who)}</span><span class="booth-text">${esc(l.text)}</span></div>
      </div>`;
    }).join("");
    host.innerHTML = `${boothHead()}${rows}`;
  }
  const btn = document.getElementById("boothRefresh");
  if (btn) btn.onclick = () => renderCommentary(true);
}

const RESULT_STAGE_ORDER = [
  { id: "group", name: "Group Stage" },
  { id: "r32", name: "Round of 32" },
  { id: "r16", name: "Round of 16" },
  { id: "qf", name: "Quarterfinal" },
  { id: "sf", name: "Semifinal" },
  { id: "third", name: "Third place" },
  { id: "final", name: "Final" },
];
const stageKey = (stage, a, b) => `${stage}|${Math.min(a, b)}|${Math.max(a, b)}`;
function fmtMatchDay(iso) { try { return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Los_Angeles" }).format(new Date(iso)); } catch (_) { return ""; } }
function fmtMatchTime(iso) { try { return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(iso)) + " PT"; } catch (_) { return ""; } }
function fmtReadDate(ms) { try { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(ms)) + " PT"; } catch (_) { return ""; } }
function agoLabel(ts) { if (!ts) return ""; const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)); if (s < 60) return "just now"; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); return `${h}h ago`; }

// One fixture row. `fx` carries names/ids/flags/stage/utcDate; `res` is the resolved
// score oriented to fx's A/B, or null when the game hasn't produced a score yet.
function matchRowHTML(fx, res) {
  const a = fx.aId != null ? teamById(fx.aId) : null;
  const b = fx.bId != null ? teamById(fx.bId) : null;
  const nameA = a ? a.name : (fx.teamA || "TBD"), flagA = a ? a.flag : (fx.flagA || "");
  const nameB = b ? b.name : (fx.teamB || "TBD"), flagB = b ? b.flag : (fx.flagB || "");
  let aw = false, bw = false, mid, cls = "";
  if (res) {
    if (fx.aId != null && fx.bId != null) {
      const out = matchOutcome({ teamA: fx.aId, teamB: fx.bId, scoreA: res.scoreA, scoreB: res.scoreB, winner: res.winner, stage: fx.stage });
      aw = out[fx.aId] === "W"; bw = out[fx.bId] === "W";
    }
    const live = res.status === "IN_PLAY" || res.status === "PAUSED";
    const pens = res.winner != null && fx.stage !== "group" && res.scoreA === res.scoreB
      ? `<div class="pens">${esc(teamById(res.winner)?.name || "")} on pens</div>` : "";
    const tag = live ? `<div class="mtag live"><span class="ls-livedot"></span>LIVE</div>` : `<div class="mtag">FT</div>`;
    mid = `<div class="sc">${res.scoreA} – ${res.scoreB}</div>${pens}${tag}`;
  } else {
    cls = " upcoming";
    mid = fx.utcDate
      ? `<div class="mtime">${esc(fmtMatchTime(fx.utcDate))}</div><div class="mdate">${esc(fmtMatchDay(fx.utcDate))}</div>`
      : `<div class="mtime">TBD</div>`;
  }
  return `<div class="match${cls}">
    <div class="ta"><span class="side ${aw ? "win" : ""}">${esc(nameA)} <span class="flag">${flagA}</span></span></div>
    <div class="match-mid">${mid}</div>
    <div class="tb"><span class="side ${bw ? "win" : ""}"><span class="flag">${flagB}</span> ${esc(nameB)}</span></div>
  </div>`;
}

function renderResults() {
  const host = document.getElementById("resultsList"); if (!host) return;

  // Commissioner/DB results keyed by fixture — manual overrides win over the feed.
  const manualMap = {};
  MATCHES.forEach((m) => { manualMap[stageKey(m.stage, m.teamA, m.teamB)] = m; });
  const matchKey = (m) => stageKey(m.stage, m.teamA, m.teamB);
  const fxKey = (f) => (f.aId != null && f.bId != null ? stageKey(f.stage, f.aId, f.bId) : null);

  // Preferred path: full schedule from the feed — every game, in kickoff order.
  if (SCHEDULE && SCHEDULE.length) {
    const scheduleKeys = new Set(SCHEDULE.map(fxKey).filter(Boolean));
    const resultFor = (fx) => {
      const mm = fx.aId != null && fx.bId != null ? manualMap[stageKey(fx.stage, fx.aId, fx.bId)] : null;
      if (mm) {
        const flip = mm.teamA !== fx.aId;   // align DB orientation to the fixture's A/B
        return { scoreA: flip ? mm.scoreB : mm.scoreA, scoreB: flip ? mm.scoreA : mm.scoreB, winner: mm.winner, status: "FINISHED" };
      }
      if (fx.scoreA != null && fx.scoreB != null) return { scoreA: fx.scoreA, scoreB: fx.scoreB, winner: fx.winner, status: fx.status };
      return null;
    };
    let html = "";
    RESULT_STAGE_ORDER.forEach((st) => {
      const fixtures = SCHEDULE.filter((f) => f.stage === st.id);
      // commissioner-entered results in this stage with no matching feed fixture (e.g. sample data)
      const extras = MATCHES.filter((m) => m.stage === st.id && !scheduleKeys.has(matchKey(m)));
      if (!fixtures.length && !extras.length) return;
      html += `<div class="stage-h">${st.name}</div>`;
      fixtures.forEach((fx) => { html += matchRowHTML(fx, resultFor(fx)); });
      extras.forEach((m) => {
        html += matchRowHTML({ aId: m.teamA, bId: m.teamB, stage: m.stage, utcDate: null },
          { scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, status: "FINISHED" });
      });
    });
    const liveN = SCHEDULE.filter((f) => f.status === "IN_PLAY" || f.status === "PAUSED").length;
    const meta = liveN
      ? `<div class="results-meta"><span class="ls-livedot"></span>${liveN} live now · auto-syncs from football-data.org</div>`
      : `<div class="results-meta">Auto-syncs from football-data.org${LAST_SYNCED ? ` · updated ${esc(agoLabel(LAST_SYNCED))}` : ""}</div>`;
    host.innerHTML = meta + html;
    return;
  }

  // Fallback (feed off / not yet synced): show only the results we have, grouped by stage.
  if (!MATCHES.length) { host.innerHTML = emptyBox("No results in yet", "Once the tournament starts, results sync automatically. The commissioner can also enter or override them."); return; }
  let html = "";
  STAGES.forEach((st) => {
    const ms = MATCHES.filter((m) => m.stage === st.id);
    if (!ms.length) return;
    html += `<div class="stage-h">${st.name}</div>`;
    ms.forEach((m) => {
      html += matchRowHTML({ aId: m.teamA, bId: m.teamB, stage: m.stage, utcDate: null },
        { scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, status: "FINISHED" });
    });
  });
  host.innerHTML = html;
}

/* ---------------- knockout daily picks ---------------- */
// Display label for a 'YYYY-MM-DD' PT game date — anchored at noon UTC so the calendar
// day never shifts under the formatter.
function fmtDailyDate(gd) {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(gd + "T12:00:00Z"));
  } catch (_) { return gd; }
}
// Knockout fixtures with both teams resolved, grouped by PT game date, kickoff-ordered.
// Empty during the group stage (bracket undrawn → every KO fixture is still TBD).
function dailySlate() {
  if (!SCHEDULE || !SCHEDULE.length) return [];
  const byDate = new Map();
  for (const f of SCHEDULE) {
    if (!KO_STAGES.has(f.stage) || f.aId == null || f.bId == null || !f.utcDate) continue;
    const gd = gameDateOf(f.utcDate);
    if (!byDate.has(gd)) byDate.set(gd, []);
    byDate.get(gd).push(f);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([gameDate, fixtures]) => ({
      gameDate,
      lock: dailyLockFor(SCHEDULE, gameDate),
      fixtures: fixtures.sort((x, y) => Date.parse(x.utcDate) - Date.parse(y.utcDate)),
    }));
}
// Player-facing standings for the $1-per-pick side pot: the running pot, a winner-takes-all
// board, plus the hot-streak and Wooden Spoon engagement hooks so the mathematically-out still
// have something live to chase. Returns "" until at least one pick is in.
function dailyPotRows() {
  if (!ENTRIES.length || !SCHEDULE) return [];
  return ENTRIES
    .map((e) => ({ e, st: dailyStats(e.id, DAILY_PICKS, SCHEDULE, MATCHES) }))
    .filter((r) => r.st.picksMade > 0)
    .sort((a, b) => b.st.points - a.st.points || b.st.winnerCorrect - a.st.winnerCorrect || a.e.name.localeCompare(b.e.name));
}
function dailyPotPanel() {
  const rows = dailyPotRows();
  if (!rows.length) return "";
  const pot = rows.reduce((n, r) => n + r.st.picksMade, 0);   // $1 per pick made
  const totalDecided = decidedKoCount(SCHEDULE, MATCHES);

  let streakLead = null;
  for (const r of rows) if (r.st.bestStreak >= 2 && (!streakLead || r.st.bestStreak > streakLead.st.bestStreak)) streakLead = r;
  // Wooden Spoon watch: most wrong, but only among players who picked every game that's been
  // played (no skipping your way to the spoon), and only once someone's actually missed one.
  let spoon = null;
  if (totalDecided > 0) {
    for (const r of rows) {
      if (r.st.decided !== totalDecided || r.st.winnerWrong === 0) continue;
      if (!spoon || r.st.winnerWrong > spoon.st.winnerWrong) spoon = r;
    }
  }

  const awards = [];
  if (streakLead) awards.push(`<span class="dp-award">🔥 Hot streak — <b>${esc(streakLead.e.name)}</b>, ${streakLead.st.bestStreak} in a row</span>`);
  if (spoon) awards.push(`<span class="dp-award dp-spoon">🥄 Wooden Spoon watch — <b>${esc(spoon.e.name)}</b>, ${spoon.st.winnerWrong} wrong</span>`);

  const board = rows.map((r, i) => {
    const st = r.st;
    const rec = st.decided ? `${st.winnerCorrect}/${st.decided}${st.pending ? ` · ${st.pending} live` : ""}` : `${st.picksMade} in`;
    return `<li class="dp-pot-row${i === 0 ? " lead" : ""}">
      <span class="dp-pot-rank">${i === 0 ? "👑" : i + 1}</span>
      <span class="dp-pot-name">${esc(r.e.name)}</span>
      <span class="dp-pot-rec">${rec}</span>
      <span class="dp-pot-pts">${st.points} pt${st.points === 1 ? "" : "s"}</span>
      <span class="dp-pot-in">$${st.picksMade}</span>
    </li>`;
  }).join("");

  return `<div class="dp-pot">
    <div class="dp-pot-head">
      <div class="dp-pot-amtwrap"><span class="dp-pot-kick">💰 Daily Pot · winner-takes-all</span><span class="dp-pot-amt">$${pot}</span></div>
      <span class="dp-pot-meta">${rows.length} player${rows.length === 1 ? "" : "s"} in · $1 per pick</span>
    </div>
    ${awards.length ? `<div class="dp-pot-awards">${awards.join("")}</div>` : ""}
    <ol class="dp-pot-board">${board}</ol>
    <p class="dp-pot-foot">$1 for every pick you make; most correct picks at the final whistle takes the pot. Ties go to your leaderboard finish, then head-to-head. The commissioner settles up over Venmo at the end. The Wooden Spoon is glory only — wear it with pride.</p>
  </div>`;
}
// Commissioner-facing tally for end-of-tournament Venmo settle: who owes what, who's winning.
function dailyPotAdmin() {
  const rows = dailyPotRows();
  if (!rows.length) return "";
  const pot = rows.reduce((n, r) => n + r.st.picksMade, 0);
  const list = rows.map((r, i) => `<div class="row" style="flex-wrap:wrap;gap:8px">
      <span style="flex:1;min-width:160px">
        <span class="pname">${i === 0 ? "👑 " : ""}${esc(r.e.name)}${r.e.venmo ? ` · @${esc(r.e.venmo)}` : ""}</span>
        <span class="pmeta" style="display:block;margin-top:2px">${r.st.points} pt${r.st.points === 1 ? "" : "s"} · ${r.st.winnerCorrect}/${r.st.decided || 0} correct</span>
      </span>
      <span class="pname" style="flex:none">$${r.st.picksMade}</span>
    </div>`).join("");
  return `<div class="card">
    <div class="row" style="font-weight:700;justify-content:space-between">
      <span>🎯 Daily Pot — settle up</span>
      <span class="pmeta" style="flex:none">$${pot} pot · ${rows.length} in</span>
    </div>
    <p class="small" style="padding:0 0 6px">$1 per daily pick, winner-takes-all. 👑 is the current leader — who takes the pot if standings hold. Collect each amount below over Venmo when the tournament ends; nothing is charged automatically.</p>
    ${list}
  </div>`;
}
// Commissioner controls for the commentary booth: set the tone and feed Ron & Chaz freeform notes
// (latest news, storylines, who to rib) — applied to the next take, no deploy needed.
const BOOTH_TONE_PRESETS = [
  ["Snarkier", "Crank up the snark — meaner, more savage ribbing (still good-natured)."],
  ["Gentler", "Ease off — more good-natured and encouraging, less savage."],
  ["More stats", "Lean hard on numbers — point gaps, records, and stats."],
  ["Max hype", "Maximum energy and hype — huge reactions, wild metaphors."],
];
function boothControlsAdmin() {
  const tone = COMMENTARY_STEER?.tone || "";
  const notes = COMMENTARY_STEER?.notes || "";
  const chips = BOOTH_TONE_PRESETS.map((p) => `<button type="button" class="btn btn-ghost cm-preset" data-tone="${esc(p[1])}" style="padding:6px 11px;font-size:12px;flex:none">${esc(p[0])}</button>`).join("");
  return `<div class="card">
    <div class="row" style="font-weight:700">🎙️ Booth controls</div>
    <p class="small" style="padding:0 0 6px">Steer Ron &amp; Chaz without a deploy. Set a tone and feed them the latest — they'll work it into the next take. Saving regenerates the booth right away.</p>
    <div class="lockwrap" style="display:flex;gap:6px;flex-wrap:wrap;padding-bottom:6px">${chips}</div>
    <div><label class="fld">Tone / style</label><input id="cmTone" value="${esc(tone)}" placeholder="e.g. extra snarky, lean on stats, more hype"></div>
    <div style="margin-top:10px"><label class="fld">Notes for the booth — news, storylines, who to rib</label>
      <textarea id="cmNotes" class="wa-text" rows="4" style="min-height:auto" placeholder="e.g. Sam is on garden leave and watching from Europe; rib Adam for being dead last; hype the Ecuador upset.">${esc(notes)}</textarea></div>
    <div class="lockwrap" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-pay" id="cmSave">Save &amp; regenerate</button>
      <button class="btn btn-ghost" id="cmClear">Clear steer</button>
    </div>
  </div>`;
}
// Commissioner tool: hand-enter confirmed knockout pairings before the live feed assigns them, so
// Daily Picks opens for that game early. Only shows near-term, not-yet-feed-resolved KO fixtures.
function koMatchupAdmin() {
  if (!SCHEDULE) return "";
  const horizon = Date.now() + 14 * 24 * 3600e3;
  const fixtures = SCHEDULE
    .filter((f) => KO_STAGES.has(f.stage) && (f.status === "TIMED" || f.status === "SCHEDULED") && f.utcDate && Date.parse(f.utcDate) <= horizon)
    .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
  if (!fixtures.length) return "";
  const opts = (selId) => `<option value="">— TBD —</option>` + TEAMS.map((t) => `<option value="${t.id}"${selId === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  const rows = fixtures.map((f) => {
    const stg = (STAGES.find((s) => s.id === f.stage) || {}).name || f.stage;
    const when = `${esc(shortDate(f.utcDate))} · ${esc(fmtMatchTime(f.utcDate))}`;
    const feedLocked = f.aId != null && f.bId != null && !KO_OVERRIDES[f.id];
    if (feedLocked) {
      return `<div class="ko-row"><span class="pmeta">${esc(stg)} · ${when}</span>
        <div class="pname">${f.flagA} ${esc(f.teamA)} v ${esc(f.teamB)} ${f.flagB} <span class="badge read">set by feed</span></div></div>`;
    }
    return `<div class="ko-row" data-koid="${f.id}">
      <span class="pmeta">${esc(stg)} · ${when}</span>
      <div class="ko-pick">
        <select class="ko-a">${opts(f.aId)}</select>
        <span class="ko-v">v</span>
        <select class="ko-b">${opts(f.bId)}</select>
        <button class="btn btn-ghost ko-save" type="button" data-koid="${f.id}">Save</button>
      </div>
    </div>`;
  }).join("");
  return `<div class="card">
    <div class="row" style="font-weight:700">🗓️ Set knockout matchups</div>
    <p class="small" style="padding:0 0 6px">Enter confirmed pairings before the live feed catches up — saving one opens Daily Picks for that game. Set both teams, or both to “— TBD —” to clear. The feed takes over once it assigns the teams itself.</p>
    ${rows}
  </div>`;
}
function renderDaily() {
  const host = document.getElementById("dailyList"); if (!host) return;
  const slate = dailySlate();
  if (!slate.length) {
    host.innerHTML = emptyBox("Daily picks open at the knockouts",
      "Once the group stage ends and the Round of 32 bracket is drawn, you'll pick a winner for every knockout match each day — $1 a pick into a winner-takes-all pot, even after your drafted teams are out. Most correct by the final whistle takes the cash, and your record also breaks ties on the main leaderboard.");
    return;
  }
  const now = Date.now();
  const winners = winnerByMatchId(SCHEDULE, MATCHES);
  const goals = goalsByMatchId(SCHEDULE, MATCHES);
  const auth = dailyId != null;
  const myName = auth ? (ENTRIES.find((e) => e.id === dailyId)?.name || "you") : null;
  const saved = auth ? savedDailyMap() : {};   // matchId -> {winner, ou}

  const cached = getCached();
  const cachedEntry = cached && ENTRIES.find((e) => e.id === cached.id);
  const gate = auth
    ? `<div class="dp-id">Picking as <b>${esc(myName)}</b><button class="btn btn-ghost dp-switch" id="dpSwitch">switch</button></div>`
    : `<div class="dp-gate">
        <div class="dp-gate-h">Make daily picks</div>
        <p class="small" style="padding:0 0 2px">Enter as yourself to lock in a winner for each day's knockout games. Your 6-char edit code — the same one you use to edit your draft — proves it's you.</p>
        ${cachedEntry ? `<button class="btn btn-pay dp-btn" id="dpMine">Continue as ${esc(cachedEntry.name)}</button>` : ""}
        <div class="dp-gate-form">
          <select id="dpName"><option value="">Select your name…</option>${[...ENTRIES].sort((a, b) => a.name.localeCompare(b.name)).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select>
          <input id="dpCode" placeholder="Edit code" maxlength="6" style="text-transform:uppercase">
          <button class="btn btn-pay dp-btn" id="dpLoad">Load my picks</button>
        </div>
      </div>`;

  let html = `<div class="dp-top">${gate}</div>${dailyPotPanel()}`;
  let dirty = false;
  let anyRealLine = false;
  let openCount = 0, pickedCount = 0;   // open (still-pickable) fixtures, and how many you've picked
  slate.forEach((day) => {
    const locked = day.lock != null && now >= day.lock;
    const badge = locked
      ? `<span class="dp-lock locked">🔒 Locked</span>`
      : (day.lock != null ? `<span class="dp-lock open">Locks ${esc(fmtMatchTime(new Date(day.lock).toISOString()))}</span>` : "");
    html += `<div class="dp-day"><div class="dp-day-h"><span class="dp-date">${esc(fmtDailyDate(day.gameDate))}</span>${badge}</div>`;
    day.fixtures.forEach((f) => {
      const sv = saved[f.id] || {};
      const dr = (auth && dailyDraft[f.id]) || {};
      const curWinner = "winner" in dr ? dr.winner : sv.winner;          // teamId | undefined
      const curOu = "ou" in dr ? dr.ou : (sv.ou || null);               // "over" | "under" | null
      const result = winners[f.id];
      const decided = result != null;
      const total = goals[f.id];
      const goalsKnown = total != null;
      const line = typeof f.ouLine === "number" ? f.ouLine : OU_LINE;   // real consensus line, snapshotted at lock
      const realLine = typeof f.ouLine === "number";
      if (realLine) anyRealLine = true;
      const correctOu = goalsKnown ? ouResult(total, line) : null;      // "over" | "under" | "push"
      const isPush = correctOu === "push";
      if (auth && !locked && (f.id in dailyDraft) &&
          (curWinner !== sv.winner || curOu !== (sv.ou || null))) dirty = true;

      const pickable = auth && !locked && !decided;   // the open, still-editable pick phase
      if (pickable) { openCount++; if (curWinner != null) pickedCount++; }

      const btn = (team) => {
        const sel = curWinner === team.id;
        let cls = "dp-pick";
        if (sel) cls += " sel";
        if (decided && result === team.id) cls += " correct";
        else if (decided && sel) cls += " wrong";
        const mark = decided
          ? (result === team.id ? " ✓" : (sel ? " ✗" : ""))
          : (sel ? " ✓" : "");   // show a clear check on your pick even before the game is graded
        return `<button class="${cls}" data-mid="${f.id}" data-team="${team.id}"${locked || !auth ? " disabled" : ""}>${team.flag} ${esc(team.name)}${mark}</button>`;
      };
      const ouBtn = (side) => {
        const sel = curOu === side;
        let cls = "dp-ou";
        if (sel) cls += " sel";
        if (goalsKnown && !isPush && side === correctOu) cls += " correct";
        else if (goalsKnown && !isPush && sel) cls += " wrong";
        const mark = goalsKnown && !isPush && side === correctOu ? " ✓" : (goalsKnown && !isPush && sel ? " ✗" : "");
        const dis = locked || !auth || curWinner == null;   // O/U is an add-on — pick a winner first
        const label = side === "over" ? `Over ${line}` : `Under ${line}`;
        return `<button class="${cls}" data-mid="${f.id}" data-ou="${side}"${dis ? " disabled" : ""}>${label}${mark}</button>`;
      };
      // A clear prompt (before a pick) / confirmation (after) for the open phase.
      let statusLine = "";
      if (pickable) {
        if (curWinner != null) {
          const w = teamById(curWinner);
          const ouTxt = curOu ? ` · ${curOu === "over" ? "Over" : "Under"} ${line}` : "";
          statusLine = `<div class="dp-yourpick">✓ Your pick: <b>${w.flag} ${esc(w.name)}</b>${ouTxt}</div>`;
        } else {
          statusLine = `<div class="dp-prompt">👆 Tap the winner</div>`;
        }
      }
      const ouNote = goalsKnown
        ? `<span class="dp-ou-final">${total} goal${total === 1 ? "" : "s"}${isPush ? " · push" : ""}</span>`
        : (pickable && curWinner != null ? `<span class="dp-ou-opt">optional</span>` : "");
      html += `<div class="dp-fixture">
        <div class="dp-match">${btn(teamById(f.aId))}<span class="dp-v">v</span>${btn(teamById(f.bId))}</div>
        ${statusLine}
        <div class="dp-ou-row"><span class="dp-ou-lab">Goals</span>${ouBtn("over")}${ouBtn("under")}${ouNote}</div>
      </div>`;
    });
    html += `</div>`;
  });
  if (auth) {
    const status = dirty
      ? "Unsaved changes — tap Save"
      : (pickedCount > 0
          ? `✓ ${pickedCount} of ${openCount} game${openCount === 1 ? "" : "s"} picked &amp; saved`
          : (openCount > 0 ? "No picks yet — tap a winner above" : "No open games right now"));
    html += `<div class="dp-actions"><button class="btn btn-pay" id="dpSave"${dirty ? "" : " disabled"}>Save my picks</button><span class="dp-savemsg ${dirty ? "dirty" : (pickedCount > 0 ? "ok" : "")}">${status}</span></div>`;
  }
  html += `<p class="dp-foot">${anyRealLine
    ? "Goal lines are the consensus Over/Under from the sportsbooks, frozen when the day locks. Books keep nudging the number after that — we grade on the line you saw, not where it lands by kickoff."
    : `Goal lines default to ${OU_LINE} until the sportsbooks post a number for the matchup; the posted consensus line is frozen when the day locks.`}</p>`;
  host.innerHTML = html;

  if (auth) {
    const sw = document.getElementById("dpSwitch");
    if (sw) sw.onclick = () => { dailyId = null; dailyCode = ""; dailyDraft = {}; renderDaily(); };
    host.querySelectorAll(".dp-pick:not([disabled])").forEach((b) => {
      b.onclick = () => {
        const mid = b.dataset.mid;
        dailyDraft[mid] = { ...(dailyDraft[mid] || {}), winner: Number(b.dataset.team) };
        renderDaily();
      };
    });
    host.querySelectorAll(".dp-ou:not([disabled])").forEach((b) => {
      b.onclick = () => {
        const mid = b.dataset.mid, side = b.dataset.ou;
        const sv = saved[mid] || {};
        const dr = dailyDraft[mid] || {};
        const cur = "ou" in dr ? dr.ou : (sv.ou || null);
        dailyDraft[mid] = { ...dr, ou: cur === side ? null : side };   // tap again to clear
        renderDaily();
      };
    });
    const save = document.getElementById("dpSave");
    if (save) save.onclick = saveDaily;
  } else {
    const mine = document.getElementById("dpMine");
    if (mine) mine.onclick = () => beginDaily(cached.id, cached.code);
    document.getElementById("dpLoad").onclick = () => {
      const id = document.getElementById("dpName").value;
      const code = document.getElementById("dpCode").value.trim().toUpperCase();
      if (!id) return flash("Pick your name");
      if (!code) return flash("Enter your edit code");
      beginDaily(id, code);
    };
  }
}
// The authed entry's stored picks, keyed by fixture id: { winner, ou }.
function savedDailyMap() {
  const m = {};
  if (dailyId != null) DAILY_PICKS.forEach((d) => {
    if (d.entryId === dailyId) m[d.matchId] = { winner: d.winner, ou: d.ou || null };
  });
  return m;
}
async function beginDaily(id, code) {
  const res = await apiPost("/api/daily", { entryId: id, editCode: code, mode: "lookup" });
  if (res.error) { flash(res.error); return; }
  dailyId = id; dailyCode = code;
  cacheEntry(id, code);   // same device cache as draft editing — one edit code unlocks both
  dailyDraft = {};
  renderDaily();
  flash("Loaded — pick your winners");
}
async function saveDaily() {
  // Only submit picks for days that haven't locked; the server re-checks the lock too.
  const now = Date.now();
  const openMatches = new Set();
  dailySlate().forEach((day) => {
    if (!(day.lock != null && now >= day.lock)) day.fixtures.forEach((f) => openMatches.add(f.id));
  });
  const sv = savedDailyMap();
  const picks = [];
  for (const mid of Object.keys(dailyDraft)) {
    if (!openMatches.has(mid)) continue;
    const merged = { ...(sv[mid] || {}), ...dailyDraft[mid] };
    if (merged.winner == null) continue;   // winner is required (the O/U is an add-on to it)
    picks.push({ matchId: mid, winner: merged.winner, ou: merged.ou ?? null });
  }
  if (!picks.length) { flash("No open picks to save"); return; }
  const res = await apiPost("/api/daily", { entryId: dailyId, editCode: dailyCode, mode: "submit", picks });
  if (res.error) { flash(res.error); return; }
  dailyDraft = {};
  applyState(res);
  flash("Daily picks saved ✅");
}

/* ---------------- commissioner: WhatsApp broadcast ---------------- */
// Template A — a paste-ready standings update. Returns plain text (emoji ok); never sends anything.
function leaderboardUpdateText() {
  const ranked = [...ENTRIES]
    .map((e) => ({ e, p: entryPoints(e) }))
    .sort((a, b) => b.p - a.p || a.e.name.localeCompare(b.e.name));
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranked.map((r, i) => `${medals[i] || `${i + 1}.`} ${r.e.name} — ${r.p} pt${r.p === 1 ? "" : "s"}`);
  let out = `🚨 LEADERBOARD UPDATE 🚨\nWorld Cup 2026 · Group of Death\n`;
  out += ranked.length ? `\n${lines.join("\n")}\n` : `\nNo entries yet.\n`;
  const nms = Array.isArray(NEXT_MATCH) ? NEXT_MATCH : (NEXT_MATCH ? [NEXT_MATCH] : []);
  if (nms.length) {
    const anyLive = nms.some((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
    const games = nms.filter((m) => m.teamA && m.teamB)
      .map((m) => `${m.flagA || ""} ${m.teamA} v ${m.teamB} ${m.flagB || ""}`.replace(/ +/g, " ").trim());
    if (games.length) out += `\n⚽ ${anyLive ? "Live now" : "Up next"}: ${games.join("  •  ")}\n`;
  }
  out += `\n📊 Live standings → ${typeof location !== "undefined" ? location.origin + BASE : ""}`;
  return out;
}

/* ---------------- admin ---------------- */
function renderAdmin() {
  const host = document.getElementById("admin"); if (!host) return;
  if (!isCommish) {
    host.innerHTML = `<div class="gate">
      <div class="h2">Commissioner</div>
      <p class="lead" style="margin:8px auto 16px">Enter the commissioner code to manage payments, results, lock, and scoring.</p>
      <input id="codeIn" placeholder="Commissioner code" style="text-align:center">
      <button class="btn btn-pay" style="margin-top:10px" id="codeBtn">Unlock</button>
      <p class="small" style="margin-top:10px">Default code: <b>1986</b> — change it once you're in.</p>
    </div>`;
    document.getElementById("codeBtn").onclick = async () => {
      const code = document.getElementById("codeIn").value.trim();
      const s = await apiPost("/api/admin", { action: "auth", code });
      if (!s.error) { isCommish = true; COMMISH_CODE = code; applyState(s); renderAdmin(); flash("Welcome, Commissioner"); }
      else flash("Wrong code");
    };
    return;
  }
  const s = CFG.scoring || DEFAULT_SCORING;
  const opts = TEAMS.map((t) => `<option value="${t.id}">${t.name} (${t.group})</option>`).join("");
  const waText = leaderboardUpdateText();
  host.innerHTML = `
    <div class="h2">Commissioner</div>
    <p class="lead">Everything the pool needs to run itself, minus collecting the cash.</p>

    <div class="card">
      <div class="row" style="font-weight:700;justify-content:space-between">
        <span>📣 Group broadcast</span>
        <span class="pmeta" style="flex:none">Leaderboard update</span>
      </div>
      <p class="small" style="padding:0 0 6px">A paste-ready standings update for the WhatsApp group. Nothing sends automatically — you copy it, then send it yourself.</p>
      <textarea id="waText" class="wa-text" rows="9" readonly>${esc(waText)}</textarea>
      <div class="lockwrap" style="display:flex;gap:10px;flex-wrap:wrap;padding-top:10px">
        <button class="btn btn-pay" id="waCopy">Copy to clipboard</button>
        <a class="btn btn-ghost wa-open" id="waOpen" href="https://wa.me/?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener">Open in WhatsApp</a>
      </div>
    </div>

    ${boothControlsAdmin()}

    <div class="card">
      <div class="row" style="font-weight:700">🎬 Preview the player experience</div>
      <p class="small" style="padding:0 0 6px">See exactly what players see. These open the real pop-ups on your screen only — nobody is notified and nothing about the pool changes.</p>
      <div class="lockwrap" style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="pvTeaser">Teaser pop-up</button>
        <button class="btn btn-ghost" id="pvLaunch">Launch pop-up 🎉</button>
        <button class="btn btn-ghost" id="pvDaily">Open Daily Picks tab</button>
        <button class="btn btn-ghost" id="pvReset">Reset pop-ups (this device)</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="font-weight:700">Pool settings</div>
      <div class="scoringgrid">
        <div><label class="fld">Pool Venmo handle</label><input id="cfgVenmo" value="${esc(CFG.venmoHandle)}" placeholder="@commissioner"></div>
        <div><label class="fld">Buy-in ($)</label><input id="cfgBuyIn" type="number" value="${CFG.buyIn}"></div>
        <div><label class="fld">Commissioner code</label><input id="cfgCode" value="${esc(COMMISH_CODE)}"></div>
      </div>
      <div class="lockwrap">
        <label class="toggle"><input type="checkbox" id="cfgLock" ${CFG.locked ? "checked" : ""} style="width:auto"> Lock entries (no new picks / edits)</label>
      </div>
      <div class="scoringgrid" style="border-top:1px solid var(--line)">
        ${[["groupWin", "Group win"], ["groupDraw", "Group draw"], ["r32", "R32 win"], ["r16", "R16 win"], ["qf", "QF win"], ["sf", "SF win"], ["final", "Final win"]]
          .map(([k, l]) => `<div><label class="fld">${l}</label><input type="number" id="sc_${k}" value="${s[k]}"></div>`).join("")}
      </div>
      <div class="lockwrap"><button class="btn btn-pay" id="saveCfg">Save settings</button></div>
    </div>

    <div class="card">
      <div class="row" style="font-weight:700;justify-content:space-between">
        <span>Mark payments &amp; collect emails</span>
        <button class="btn btn-ghost" id="copyEmails" style="padding:7px 12px;font-size:12px;flex:none">Copy all emails</button>
      </div>
      <p class="small" style="padding:0 0 6px">📣 Daily Picks teaser read: <b>${ENTRIES.filter((e) => e.teaserReadAt).length}</b> of ${ENTRIES.length} confirmed</p>
      ${ENTRIES.length ? ENTRIES.map((e) => `<div class="row" style="flex-wrap:wrap">
          <span style="flex:1;min-width:160px">
            <span class="pname">${esc(e.name)}</span>
            ${e.teaserReadAt ? `<span class="badge read" title="Teaser read ${esc(fmtReadDate(e.teaserReadAt))}">✓ read</span>` : `<span class="badge unread">teaser unread</span>`}
            <span class="pmeta" style="display:block;margin-top:2px">${e.email ? esc(e.email) : "(no email)"}${e.venmo ? " · @" + esc(e.venmo) : ""}</span>
          </span>
          <button class="btn ${e.paid ? "btn-ghost" : "btn-pay"}" style="padding:8px 14px;font-size:13px" data-pay="${e.id}">${e.paid ? "Mark unpaid" : "Mark paid"}</button>
          <button class="btn btn-ghost" style="padding:8px 12px;font-size:13px;flex:none" data-editpicks="${e.id}" title="Edit this player's picks">Edit picks</button>
          <button class="btn btn-ghost" style="padding:8px 12px;font-size:13px;flex:none" data-code="${e.id}" title="Reveal this player's edit code">Show code</button>
          <button class="btn btn-ghost" style="padding:8px 12px;font-size:14px;flex:none" data-del="${e.id}" title="Remove entry from the pool">✕</button>
          <div class="code-reveal" id="cr-${e.id}" style="flex:0 0 100%;display:none"></div>
        </div>`).join("") : `<div class="empty">No entries yet.</div>`}
    </div>

    ${dailyPotAdmin()}

    ${koMatchupAdmin()}

    <div class="card">
      <div class="row" style="font-weight:700" id="resFormHead">${editMatchId ? "Edit result" : "Enter a result (override)"}</div>
      <div class="scoringgrid">
        <div><label class="fld">Stage</label><select id="rStage">${STAGES.map((st) => `<option value="${st.id}">${st.name}</option>`).join("")}</select></div>
        <div><label class="fld">Team A</label><select id="rA">${opts}</select></div>
        <div><label class="fld">Score A</label><input type="number" id="rSA" min="0" value="0"></div>
        <div><label class="fld">Team B</label><select id="rB">${opts}</select></div>
        <div><label class="fld">Score B</label><input type="number" id="rSB" min="0" value="0"></div>
        <div><label class="fld">Winner if KO tie</label><select id="rW"><option value="">— auto —</option>${opts}</select></div>
      </div>
      <div class="lockwrap" style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-pay" id="addRes">${editMatchId ? "Save changes" : "Add result"}</button>
        ${editMatchId ? `<button class="btn btn-ghost" id="cancelResEdit">Cancel edit</button>` : ""}
        <button class="btn btn-pay" id="syncRes">Sync live results now</button>
        <button class="btn btn-ghost" id="sampleRes">Load sample results</button>
        <button class="btn btn-ghost" id="clearRes">Clear all results</button>
      </div>
      <p class="small lockwrap" style="padding-top:0">Live results sync automatically from football-data.org about once a minute. Use this form for anything the feed lags on (e.g. penalty-shootout winners), then Edit/✕ below to fix a typo.</p>
    </div>

    <div class="card">
      <div class="row" style="font-weight:700">Current results (${MATCHES.length})</div>
      ${MATCHES.length ? [...MATCHES].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)).map((m) => {
        const a = teamById(m.teamA), b = teamById(m.teamB);
        const stg = (STAGES.find((s) => s.id === m.stage) || {}).name || m.stage;
        const pens = m.winner != null && m.stage !== "group" && m.scoreA === m.scoreB ? ` · ${esc(teamById(m.winner)?.name || "")} on pens` : "";
        return `<div class="row" style="flex-wrap:wrap;gap:8px">
          <span style="flex:1;min-width:170px">
            <span class="pname">${a ? a.flag : ""} ${esc(a ? a.name : "?")} <b>${m.scoreA}–${m.scoreB}</b> ${b ? b.flag : ""} ${esc(b ? b.name : "?")}</span>
            <span class="pmeta" style="display:block;margin-top:2px">${esc(stg)} · ${esc(m.source || "manual")}${pens}</span>
          </span>
          <button class="btn btn-ghost" style="padding:8px 12px;font-size:13px;flex:none" data-editres="${m.id}">Edit</button>
          <button class="btn btn-ghost" style="padding:8px 12px;font-size:14px;flex:none" data-delres="${m.id}" title="Delete this result">✕</button>
        </div>`;
      }).join("") : `<div class="empty">No results entered yet.</div>`}
    </div>`;

  host.querySelectorAll("[data-pay]").forEach((b) => b.onclick = async () => {
    applyState(await apiPost("/api/admin", { action: "pay", code: COMMISH_CODE, id: b.dataset.pay }));
    renderAdmin();
  });
  host.querySelectorAll("[data-editpicks]").forEach((b) => b.onclick = () => beginCommishEdit(b.dataset.editpicks));
  host.querySelectorAll("[data-code]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.code;
    const res = await apiPost("/api/admin", { action: "revealCode", code: COMMISH_CODE, id });
    if (res.error) { flash(res.error); return; }
    const ent = ENTRIES.find((e) => e.id === id);
    const cr = document.getElementById("cr-" + id);
    if (!cr) return;
    const code = res.editCode || "(none)";
    cr.style.display = "";
    cr.innerHTML = `<div class="cr-inner">
      <span class="cr-label">Edit code</span>
      <code class="cr-code">${esc(code)}</code>
      <button class="btn btn-ghost cr-copy" data-copyval="${esc(code)}">Copy</button>
      <span class="cr-help">Send this to ${esc(ent ? ent.name : "the player")} along with the link to your pool → Rosters tab → “Request a code to edit your picks”. They enter their name + this code to change their own picks before kickoff.</span>
    </div>`;
    cr.querySelector(".cr-copy").onclick = async (ev) => {
      try { await navigator.clipboard.writeText(ev.currentTarget.dataset.copyval); flash("Edit code copied"); }
      catch (_) { flash("Couldn't copy — select the code manually"); }
    };
  });
  host.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    const ent = ENTRIES.find((e) => e.id === b.dataset.del);
    if (!confirm(`Remove ${ent ? ent.name : "this entry"} from the pool? This can't be undone.`)) return;
    const res = await apiPost("/api/admin", { action: "deleteEntry", code: COMMISH_CODE, id: b.dataset.del });
    if (res.error) { flash(res.error); return; }
    applyState(res); renderAdmin(); flash("Entry removed");
  });
  host.querySelectorAll(".cm-preset").forEach((b) => b.onclick = () => {
    const t = document.getElementById("cmTone"); if (t) { t.value = b.dataset.tone; t.focus(); }
  });
  const cmSave = document.getElementById("cmSave");
  const saveSteer = async (tone, notes) => {
    const res = await apiPost("/api/admin", { action: "commentarySteer", code: COMMISH_CODE, tone, notes });
    if (res.error) { flash(res.error); return; }
    applyState(res); renderAdmin();
    flash("Booth steer saved — regenerating…");
    renderCommentary(true);   // force a fresh take that picks up the new steer
  };
  if (cmSave) cmSave.onclick = () => saveSteer(
    (document.getElementById("cmTone").value || "").trim(),
    (document.getElementById("cmNotes").value || "").trim(),
  );
  const cmClear = document.getElementById("cmClear");
  if (cmClear) cmClear.onclick = () => saveSteer("", "");
  host.querySelectorAll(".ko-save").forEach((b) => b.onclick = async () => {
    const row = b.closest(".ko-row");
    const aId = row.querySelector(".ko-a").value;
    const bId = row.querySelector(".ko-b").value;
    const res = await apiPost("/api/admin", { action: "koMatchup", code: COMMISH_CODE, fixtureId: b.dataset.koid, aId, bId });
    if (res.error) { flash(res.error); return; }
    applyState(res); renderAdmin();
    flash(aId && bId ? "Matchup saved — Daily Picks open for it" : "Matchup cleared");
  });
  const waCopy = document.getElementById("waCopy");
  if (waCopy) waCopy.onclick = async () => {
    const txt = (document.getElementById("waText") || {}).value || "";
    try { await navigator.clipboard.writeText(txt); flash("Leaderboard update copied — paste into WhatsApp"); }
    catch (_) { const t = document.getElementById("waText"); if (t) { t.focus(); t.select(); } flash("Press ⌘/Ctrl+C to copy"); }
  };
  const ce = document.getElementById("copyEmails");
  if (ce) ce.onclick = () => {
    const list = ENTRIES.map((e) => e.email).filter(Boolean).join(", ");
    try { navigator.clipboard.writeText(list); } catch (_) {}
    flash(list ? "Emails copied to clipboard" : "No emails yet");
  };
  // Preview-the-experience panel — pop the real player-facing pop-ups for the commissioner only.
  const pvT = document.getElementById("pvTeaser");
  if (pvT) pvT.onclick = () => maybeDailyModal("teaser", { preview: true });
  const pvL = document.getElementById("pvLaunch");
  if (pvL) pvL.onclick = () => maybeDailyModal("launch", { preview: true });
  const pvD = document.getElementById("pvDaily");
  if (pvD) pvD.onclick = () => showTab("daily");
  const pvR = document.getElementById("pvReset");
  if (pvR) pvR.onclick = () => {
    try { localStorage.removeItem("wc-daily-teaser-seen"); localStorage.removeItem("wc-daily-launch-seen"); } catch (_) {}
    flash("Pop-ups reset — they'll show again on your next visit");
  };
  document.getElementById("saveCfg").onclick = async () => {
    const config = {
      venmoHandle: document.getElementById("cfgVenmo").value.trim().replace(/^@/, ""),
      buyIn: +document.getElementById("cfgBuyIn").value || 50,
      commishCode: document.getElementById("cfgCode").value.trim() || "1986",
      locked: document.getElementById("cfgLock").checked,
      scoring: {},
    };
    ["groupWin", "groupDraw", "r32", "r16", "qf", "sf", "final"].forEach((k) => config.scoring[k] = +document.getElementById("sc_" + k).value || 0);
    const res = await apiPost("/api/admin", { action: "config", code: COMMISH_CODE, config });
    if (res.error) { flash(res.error); return; }
    COMMISH_CODE = config.commishCode;
    applyState(res); renderAdmin(); flash("Settings saved");
  };
  document.getElementById("addRes").onclick = async () => {
    const teamA = +document.getElementById("rA").value, teamB = +document.getElementById("rB").value;
    if (teamA === teamB) return flash("Pick two different teams");
    const match = {
      stage: document.getElementById("rStage").value,
      teamA, teamB,
      scoreA: +document.getElementById("rSA").value,
      scoreB: +document.getElementById("rSB").value,
      winner: document.getElementById("rW").value,
    };
    const editing = editMatchId;
    const res = await apiPost("/api/admin", editing
      ? { action: "editResult", code: COMMISH_CODE, id: editing, match }
      : { action: "result", code: COMMISH_CODE, match });
    if (res.error) { flash(res.error); return; }
    editMatchId = null;
    applyState(res); renderAdmin(); flash(editing ? "Result updated" : "Result added");
  };
  host.querySelectorAll("[data-editres]").forEach((b) => b.onclick = () => {
    const m = MATCHES.find((x) => x.id === b.dataset.editres); if (!m) return;
    editMatchId = m.id;
    renderAdmin();   // re-render so the form heading/button switch to edit mode
    document.getElementById("rStage").value = m.stage;
    document.getElementById("rA").value = m.teamA;
    document.getElementById("rB").value = m.teamB;
    document.getElementById("rSA").value = m.scoreA;
    document.getElementById("rSB").value = m.scoreB;
    document.getElementById("rW").value = m.winner == null ? "" : m.winner;
    document.getElementById("resFormHead").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  host.querySelectorAll("[data-delres]").forEach((b) => b.onclick = async () => {
    const m = MATCHES.find((x) => x.id === b.dataset.delres);
    const a = m ? teamById(m.teamA) : null, bb = m ? teamById(m.teamB) : null;
    if (!confirm(`Delete this result${a && bb ? ` (${a.name} ${m.scoreA}–${m.scoreB} ${bb.name})` : ""}? A feed result may re-sync on the next refresh.`)) return;
    const res = await apiPost("/api/admin", { action: "deleteMatch", code: COMMISH_CODE, id: b.dataset.delres });
    if (res.error) { flash(res.error); return; }
    if (editMatchId === b.dataset.delres) editMatchId = null;
    applyState(res); renderAdmin(); flash("Result deleted");
  });
  const cancelRes = document.getElementById("cancelResEdit");
  if (cancelRes) cancelRes.onclick = () => { editMatchId = null; renderAdmin(); };
  document.getElementById("sampleRes").onclick = async () => {
    applyState(await apiPost("/api/admin", { action: "sample", code: COMMISH_CODE })); renderAdmin(); flash("Sample results loaded");
  };
  document.getElementById("clearRes").onclick = async () => {
    applyState(await apiPost("/api/admin", { action: "clearResults", code: COMMISH_CODE })); renderAdmin(); flash("Results cleared");
  };
  document.getElementById("syncRes").onclick = async () => {
    flash("Syncing live results…");
    const res = await apiPost("/api/admin", { action: "sync", code: COMMISH_CODE });
    if (res.error) { flash(res.error); return; }
    applyState(res); renderAdmin();
    const s = res.sync;
    flash(s && s.ok ? (s.upserts ? `Synced — ${s.upserts} match${s.upserts > 1 ? "es" : ""} updated` : "Synced — no finished matches yet") : `Sync failed: ${s ? s.reason : "unknown"}`);
  };
}

/* ---------------- misc ---------------- */
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function emptyBox(t, s) { return `<div class="card"><div class="empty"><b>${t}</b>${s}</div></div>`; }
let flashT;
function flash(msg) {
  const f = document.getElementById("flash"); if (!f) return;
  f.textContent = msg; f.classList.add("show");
  clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove("show"), 2600);
}
function renderLiveStrip() {
  const el = document.getElementById("countdown"); if (!el) return;
  const ranked = [...ENTRIES].map((e) => ({ e, p: entryPoints(e) })).sort((a, b) => b.p - a.p);
  const pot = ENTRIES.length * (CFG.buyIn || 0);
  const cnt = ENTRIES.length;
  const medal = (m, r) => r
    ? `<div class="ls-cell"><span class="ls-medal">${m}</span><div class="ls-who"><span class="ls-name">${esc(r.e.name)}</span><span class="ls-sub">${r.p} pts</span></div></div>`
    : `<div class="ls-cell"><span class="ls-medal">${m}</span><div class="ls-who"><span class="ls-name ls-dim">No entries yet</span></div></div>`;
  // NEXT_MATCH is the slot's games (array). Normalize — older cached data may be a single object.
  const nms = Array.isArray(NEXT_MATCH) ? NEXT_MATCH : (NEXT_MATCH ? [NEXT_MATCH] : []);
  let matchHtml;
  if (nms.length) {
    const anyLive = nms.some((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
    const fixtures = nms.map((m) => {
      const live = m.status === "IN_PLAY" || m.status === "PAUSED";
      return `<div class="ls-fixture">${m.flagA || ""} ${esc(m.teamA)} <span class="ls-vs">${live && m.score ? esc(m.score) : "v"}</span> ${esc(m.teamB)} ${m.flagB || ""}</div>`;
    }).join("");
    matchHtml = `<div class="ls-cell ls-match">
      <span class="ls-sub">${anyLive ? '<span class="ls-livedot"></span>Now playing' : "Up next"}</span>
      ${fixtures}
      ${!anyLive && nms[0].when ? `<span class="ls-sub">${esc(nms[0].when)}</span>` : ""}
    </div>`;
  } else {
    matchHtml = `<div class="ls-cell ls-match"><span class="ls-sub">Up next</span><div class="ls-fixture ls-dim">Schedule syncing…</div></div>`;
  }
  el.classList.add("live");
  el.innerHTML = `
    <div class="ls-cell ls-status"><span class="ls-livedot"></span><span class="ls-live">LIVE</span></div>
    ${medal("🥇", ranked[0])}
    ${medal("🥈", ranked[1])}
    <div class="ls-cell ls-pot"><span class="ls-medal">💰</span><div class="ls-who"><span class="ls-name">$${pot.toLocaleString()}</span><span class="ls-sub">${cnt} ${cnt === 1 ? "entry" : "entries"}</span></div></div>
    ${matchHtml}`;
}
function renderPotNote() {
  const el = document.getElementById("potNote"); if (!el) return;
  // Pre-kickoff only — the live strip carries the pot once games start.
  if (KICKOFF - new Date() <= 0) { el.style.display = "none"; el.innerHTML = ""; return; }
  const paid = ENTRIES.filter((e) => e.paid);
  if (!paid.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  const pot = paid.length * (CFG.buyIn || 0);
  el.style.display = "";
  el.innerHTML = `<span class="pn-medal">💰</span><span class="pn-amt">$${pot.toLocaleString()}</span><span class="pn-sub">in the pot · ${paid.length} paid</span>`;
}
function tickCountdown() {
  const el = document.getElementById("countdown"); if (!el) return;
  let diff = KICKOFF - new Date();
  if (diff <= 0) { if (!el.classList.contains("live")) renderLiveStrip(); return; }
  el.classList.remove("live");
  const d = Math.floor(diff / 864e5); diff %= 864e5;
  const h = Math.floor(diff / 36e5); diff %= 36e5;
  const m = Math.floor(diff / 6e4); diff %= 6e4;
  const s = Math.floor(diff / 1e3);
  const u = (v, l) => `<div class="cd-unit"><div class="val">${String(v).padStart(2, "0")}</div><div class="lab">${l}</div></div>`;
  el.innerHTML = `<div class="lab" style="writing-mode:vertical-rl;transform:rotate(180deg)">Kickoff</div>` +
    u(d, "days") + '<span class="cd-sep">:</span>' + u(h, "hrs") + '<span class="cd-sep">:</span>' + u(m, "min") + '<span class="cd-sep">:</span>' + u(s, "sec");
}

/* ---------------- tabs ---------------- */
function showTab(name) {
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.remove("active"));
  const btn = document.querySelector(`nav.tabs button[data-tab="${name}"]`);
  if (btn) btn.classList.add("active");
  document.querySelectorAll("section").forEach((sx) => sx.classList.remove("show"));
  const sec = document.getElementById(name); if (sec) sec.classList.add("show");
  renderDailyNudge();   // hide the nudge when they're already on the daily tab
}
const started = () => Date.now() >= KICKOFF.getTime();
// Once the tournament kicks off, the Draft is closed — grey the tab so players can't
// wander back into a locked draft (commissioner edits still jump there programmatically).
function applyTabGate() {
  const draftBtn = document.querySelector('nav.tabs button[data-tab="draft"]');
  if (draftBtn) draftBtn.classList.toggle("tab-disabled", started());
}

/* ---------------- mount ---------------- */
export function mountApp() {
  ME = loadMe();
  const tabs = document.getElementById("tabs");
  if (tabs) tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("tab-disabled")) return;   // Draft is closed post-kickoff
    showTab(b.dataset.tab);
  });
  applyTabGate();
  applyDailyGate();   // hide Daily Picks until revealed (state load re-runs this once schedule arrives)
  if (started()) showTab("leaderboard");   // default landing once games are underway
  document.getElementById("inName").addEventListener("input", renderTicket);
  document.getElementById("inEmail").addEventListener("input", renderTicket);
  document.getElementById("submitBtn").addEventListener("click", () => editId ? updatePicks() : submitEntry());
  document.getElementById("cancelEditBtn").addEventListener("click", cancelEdit);

  (async () => {
    const s = await apiGet();
    applyState(s);
    renderAdmin();
    tickCountdown(); setInterval(tickCountdown, 1000);
    // refresh shared state periodically so leaderboard/rosters stay live
    setInterval(async () => { applyState(await apiGet()); if (isCommish) renderAdmin(); }, 30000);
  })();
}
