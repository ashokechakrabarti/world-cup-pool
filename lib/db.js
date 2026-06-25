import { Pool } from "pg";
import { resolveTeam, STAGE_MAP, DEFAULT_SCORING, TEAMS } from "./teams.js";
import { KO_STAGES, gameDateOf, dailyLockFor } from "./scoring.js";

// 6-char edit code, unambiguous alphabet (no 0/O/1/I).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

let _pool;
export function pool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }
  return _pool;
}

let _ready;
export function ensureSchema() {
  if (_ready) return _ready;
  _ready = (async () => {
    const p = pool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS pool_config (
        id INT PRIMARY KEY DEFAULT 1,
        buy_in INT NOT NULL DEFAULT 50,
        venmo_handle TEXT NOT NULL DEFAULT '',
        commish_code TEXT NOT NULL DEFAULT '1986',
        locked BOOLEAN NOT NULL DEFAULT FALSE,
        scoring JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_synced BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        venmo TEXT NOT NULL DEFAULT '',
        paid BOOLEAN NOT NULL DEFAULT FALSE,
        picks JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        team_a INT NOT NULL,
        team_b INT NOT NULL,
        score_a INT,
        score_b INT,
        winner INT,
        source TEXT NOT NULL DEFAULT 'manual',
        updated_at BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS daily_picks (
        entry_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        game_date TEXT NOT NULL,
        predicted_winner INT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (entry_id, match_id)
      );
      ALTER TABLE daily_picks ADD COLUMN IF NOT EXISTS predicted_ou TEXT;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS next_match JSONB;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS commentary JSONB;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS upcoming JSONB;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS schedule JSONB;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS ou_lines JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS last_odds_synced BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS ko_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE pool_config ADD COLUMN IF NOT EXISTS commentary_steer JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE entries ADD COLUMN IF NOT EXISTS edit_code TEXT;
      ALTER TABLE entries ADD COLUMN IF NOT EXISTS teaser_read_at BIGINT;
    `);
    // Backfill: give any pre-existing entry a self-service edit code (one-time, idempotent).
    const missing = await p.query(`SELECT id FROM entries WHERE edit_code IS NULL OR edit_code = ''`);
    for (const row of missing.rows) {
      await p.query(`UPDATE entries SET edit_code = $1 WHERE id = $2`, [genCode(), row.id]);
    }
    await p.query(
      `INSERT INTO pool_config (id, venmo_handle, scoring)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [process.env.POOL_VENMO_HANDLE || "", JSON.stringify(DEFAULT_SCORING)]
    );
  })();
  return _ready;
}

export async function getState() {
  await ensureSchema();
  const p = pool();
  const [cfg, ent, mat, dp] = await Promise.all([
    p.query(`SELECT * FROM pool_config WHERE id = 1`),
    p.query(`SELECT * FROM entries ORDER BY created_at ASC`),
    p.query(`SELECT * FROM matches`),
    p.query(`SELECT entry_id, match_id, game_date, predicted_winner, predicted_ou FROM daily_picks`),
  ]);
  const c = cfg.rows[0] || {};
  return {
    config: {
      buyIn: c.buy_in ?? 50,
      venmoHandle: c.venmo_handle ?? "",
      locked: !!c.locked,
      scoring: { ...DEFAULT_SCORING, ...(c.scoring || {}) },
    },
    nextMatch: c.next_match || null,
    schedule: applyKoOverrides(c.schedule, c.ko_overrides),
    koOverrides: c.ko_overrides || {},
    commentarySteer: c.commentary_steer || {},
    lastSynced: Number(c.last_synced || 0),
    entries: ent.rows.map((e) => ({
      id: e.id, name: e.name, email: e.email, venmo: e.venmo,
      paid: e.paid, picks: e.picks, createdAt: Number(e.created_at),
      teaserReadAt: e.teaser_read_at != null ? Number(e.teaser_read_at) : null,
    })),
    matches: mat.rows.map((m) => ({
      id: m.id, stage: m.stage, teamA: m.team_a, teamB: m.team_b,
      scoreA: m.score_a, scoreB: m.score_b, winner: m.winner, source: m.source,
      updatedAt: Number(m.updated_at || 0),
    })),
    dailyPicks: dp.rows.map((d) => ({
      entryId: d.entry_id, matchId: d.match_id, gameDate: d.game_date,
      winner: d.predicted_winner, ou: d.predicted_ou || null,
    })),
  };
}

// Pull finished matches from football-data.org and upsert feed rows.
// Manual (commissioner) rows are never overwritten — they win.
export async function syncFromFeed() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return { ok: false, reason: "no token" };
  await ensureSchema();
  const p = pool();

  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
    headers: { "X-Auth-Token": token },
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, reason: `feed ${res.status}` };
  const data = await res.json();
  const fixtures = data.matches || [];
  let upserts = 0;

  for (const m of fixtures) {
    if (m.status !== "FINISHED") continue;
    const stage = STAGE_MAP[m.stage] || null;
    if (!stage) continue;
    const a = resolveTeam(m.homeTeam?.name);
    const b = resolveTeam(m.awayTeam?.name);
    if (a == null || b == null) continue;
    const ft = m.score?.fullTime || {};
    const scoreA = ft.home, scoreB = ft.away;
    if (scoreA == null || scoreB == null) continue;
    let winner = null;
    if (stage !== "group") {
      const w = m.score?.winner; // HOME_TEAM | AWAY_TEAM | DRAW (penalties reflected here)
      winner = w === "HOME_TEAM" ? a : w === "AWAY_TEAM" ? b : null;
    }
    const id = "fd" + m.id;
    await p.query(
      `INSERT INTO matches (id, stage, team_a, team_b, score_a, score_b, winner, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'feed',$8)
       ON CONFLICT (id) DO UPDATE SET
         score_a=EXCLUDED.score_a, score_b=EXCLUDED.score_b, winner=EXCLUDED.winner,
         stage=EXCLUDED.stage, updated_at=EXCLUDED.updated_at
       WHERE matches.source = 'feed'`,
      [id, stage, a, b, scoreA, scoreB, winner, Date.now()]
    );
    upserts++;
  }

  const nextMatches = pickNextMatches(fixtures);
  const upcoming = pickUpcoming(fixtures);
  const schedule = buildSchedule(fixtures);
  // Snapshot real O/U lines onto knockout fixtures (own quota throttle inside; falls back to a
  // fixed line when unavailable). Attach before persisting so getState ships the line per fixture.
  const ouLines = await refreshOddsLines(schedule);
  for (const f of schedule) f.ouLine = ouLines[f.id] ?? null;
  await p.query(
    `UPDATE pool_config SET last_synced = $1, next_match = $2, upcoming = $3, schedule = $4 WHERE id = 1`,
    [Date.now(), nextMatches.length ? JSON.stringify(nextMatches) : null, JSON.stringify(upcoming), JSON.stringify(schedule)]
  );
  return { ok: true, upserts };
}

// How often we're willing to spend an odds request. The Odds API free tier is 500 req/mo, so a
// 6-hour floor (~120 calls/mo even if synced constantly) keeps us comfortably under quota.
const ODDS_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ODDS_SPORT_KEY = "soccer_fifa_world_cup";

// Snapshot consensus Over/Under lines onto the knockout fixtures of `schedule`, returning the
// matchId -> line map. A fixture's line is frozen once its game-date locks (earliest kickoff that
// day): players are graded on the number shown when they picked, and post-lock book drift is
// deliberately ignored. Heavily throttled against the odds quota; a missing key, a failed fetch,
// or an unposted line all leave the fixture without a line, so scoring falls back to the fixed line.
async function refreshOddsLines(schedule) {
  const p = pool();
  const row = await p.query(`SELECT ou_lines, last_odds_synced FROM pool_config WHERE id = 1`);
  const stored = row.rows[0]?.ou_lines || {};
  const lastOdds = Number(row.rows[0]?.last_odds_synced || 0);
  const key = process.env.ODDS_API_KEY;
  const now = Date.now();

  // Only knockout fixtures whose day hasn't locked are eligible for a (re)freshed line. Locked
  // fixtures keep their stored snapshot. If nothing is open, there's nothing worth spending on.
  const openKo = (schedule || []).filter((f) => {
    if (!KO_STAGES.has(f.stage) || f.aId == null || f.bId == null || !f.utcDate) return false;
    const lock = dailyLockFor(schedule, gameDateOf(f.utcDate));
    return lock == null || now < lock;
  });

  if (!key || !openKo.length || now - lastOdds < ODDS_SYNC_INTERVAL_MS) return stored;

  let events;
  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/${ODDS_SPORT_KEY}/odds?apiKey=${key}&regions=us,uk,eu&markets=totals&oddsFormat=decimal`,
      { cache: "no-store" }
    );
    // Record the attempt regardless so a failing or exhausted key doesn't retry every sync tick.
    if (!res.ok) {
      await p.query(`UPDATE pool_config SET last_odds_synced = $1 WHERE id = 1`, [now]);
      return stored;
    }
    events = await res.json();
  } catch {
    await p.query(`UPDATE pool_config SET last_odds_synced = $1 WHERE id = 1`, [now]);
    return stored;
  }

  // Index the consensus line from each event by its unordered team-id pair.
  const byPair = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const line = consensusTotal(ev);
    if (line == null) continue;
    const a = resolveTeam(ev.home_team);
    const b = resolveTeam(ev.away_team);
    if (a == null || b == null) continue;
    byPair.set(pairKey(a, b), line);
  }

  const next = { ...stored };
  for (const f of openKo) {
    const line = byPair.get(pairKey(f.aId, f.bId));
    if (line != null) next[f.id] = line;
  }

  await p.query(
    `UPDATE pool_config SET ou_lines = $1, last_odds_synced = $2 WHERE id = 1`,
    [JSON.stringify(next), now]
  );
  return next;
}

function pairKey(a, b) { return `${Math.min(a, b)}|${Math.max(a, b)}`; }

// Consensus (median) total goals for an event across every book quoting a totals market, rounded
// to the nearest half-goal. The half-step guarantees the line can't land on an integer goal total,
// so a real push is impossible in practice (scoring still defends against a whole-number line).
function consensusTotal(ev) {
  const points = [];
  for (const bk of ev.bookmakers || []) {
    const tot = (bk.markets || []).find((mk) => mk.key === "totals");
    const pt = tot?.outcomes?.[0]?.point;
    if (typeof pt === "number") points.push(pt);
  }
  if (!points.length) return null;
  points.sort((x, y) => x - y);
  const mid = Math.floor(points.length / 2);
  const median = points.length % 2 ? points[mid] : (points[mid - 1] + points[mid]) / 2;
  return Math.round(median * 2) / 2;
}

// The full tournament fixture list, resolved to our team ids, in kickoff order.
// Carries live/final scores from the feed so the Results board can show every game —
// scheduled, in-play, or finished — even though only FINISHED games score points.
// Overlay commissioner-entered knockout matchups onto the stored schedule. Applied at read time
// (so it survives feed syncs) and ONLY to fixtures the feed hasn't resolved itself — once the feed
// assigns real teams, the feed wins and the override is ignored.
export function applyKoOverrides(schedule, overrides) {
  if (!Array.isArray(schedule)) return schedule || null;
  if (!overrides || !Object.keys(overrides).length) return schedule;
  return schedule.map((f) => {
    const o = overrides[f.id];
    if (!o || (f.aId != null && f.bId != null)) return f;
    const { aId, bId } = o;
    if (aId == null || bId == null || !TEAMS[aId] || !TEAMS[bId]) return f;
    return {
      ...f, aId, bId,
      teamA: TEAMS[aId].name, teamB: TEAMS[bId].name,
      flagA: TEAMS[aId].flag, flagB: TEAMS[bId].flag,
    };
  });
}
function buildSchedule(fixtures) {
  return fixtures
    .slice()
    .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))
    .map((m) => {
      const aId = resolveTeam(m.homeTeam?.name);
      const bId = resolveTeam(m.awayTeam?.name);
      const ft = m.score?.fullTime || {};
      const hasScore = ft.home != null && ft.away != null;
      let winner = null;
      if (hasScore) {
        const w = m.score?.winner; // HOME_TEAM | AWAY_TEAM | DRAW
        winner = w === "HOME_TEAM" ? (aId ?? null) : w === "AWAY_TEAM" ? (bId ?? null) : null;
      }
      return {
        id: "fd" + m.id,
        stage: STAGE_MAP[m.stage] || (m.stage === "THIRD_PLACE" ? "third" : "group"),
        group: m.group || null,
        utcDate: m.utcDate,
        status: m.status,
        aId: aId ?? null,
        bId: bId ?? null,
        teamA: aId != null ? TEAMS[aId].name : (m.homeTeam?.name || "TBD"),
        teamB: bId != null ? TEAMS[bId].name : (m.awayTeam?.name || "TBD"),
        flagA: aId != null ? TEAMS[aId].flag : "",
        flagB: bId != null ? TEAMS[bId].flag : "",
        scoreA: hasScore ? ft.home : null,
        scoreB: hasScore ? ft.away : null,
        winner,
      };
    });
}

// The next handful of unplayed fixtures, with resolved team ids so the
// commentary booth can tie them to players' squads and points at stake.
function pickUpcoming(fixtures, limit = 10) {
  return fixtures
    .filter((m) => (m.status === "TIMED" || m.status === "SCHEDULED") && Date.parse(m.utcDate) >= Date.now() - 2 * 60 * 60 * 1000)
    .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate))
    .slice(0, limit)
    .map((m) => {
      const aId = resolveTeam(m.homeTeam?.name);
      const bId = resolveTeam(m.awayTeam?.name);
      return {
        stage: STAGE_MAP[m.stage] || "group",
        aId: aId ?? null,
        bId: bId ?? null,
        teamA: aId != null ? TEAMS[aId].name : (m.homeTeam?.name || "TBD"),
        teamB: bId != null ? TEAMS[bId].name : (m.awayTeam?.name || "TBD"),
        flagA: aId != null ? TEAMS[aId].flag : "",
        flagB: bId != null ? TEAMS[bId].flag : "",
        when: fmtKickoff(m.utcDate),
      };
    });
}

// Choose what to show in the live strip: a match in progress, else the soonest upcoming one.
// All the games sharing the current slot, so the live strip can show simultaneous fixtures:
// every match in progress, or \u2014 if none are live \u2014 every match at the earliest upcoming kickoff.
function pickNextMatches(fixtures) {
  let chosen = fixtures.filter((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
  if (!chosen.length) {
    const upcoming = fixtures
      .filter((m) => (m.status === "TIMED" || m.status === "SCHEDULED") && Date.parse(m.utcDate) >= Date.now() - 2 * 60 * 60 * 1000)
      .sort((a, b) => Date.parse(a.utcDate) - Date.parse(b.utcDate));
    if (!upcoming.length) return [];
    const t0 = Date.parse(upcoming[0].utcDate);
    chosen = upcoming.filter((m) => Date.parse(m.utcDate) === t0);   // same kickoff time = simultaneous
  }
  return chosen.map((m) => {
    const aId = resolveTeam(m.homeTeam?.name);
    const bId = resolveTeam(m.awayTeam?.name);
    const ft = m.score?.fullTime || {};
    return {
      status: m.status,
      teamA: aId != null ? TEAMS[aId].name : (m.homeTeam?.name || "TBD"),
      teamB: bId != null ? TEAMS[bId].name : (m.awayTeam?.name || "TBD"),
      flagA: aId != null ? TEAMS[aId].flag : "",
      flagB: bId != null ? TEAMS[bId].flag : "",
      when: fmtKickoff(m.utcDate),
      score: ft.home != null && ft.away != null ? `${ft.home} \u2013 ${ft.away}` : null,
    };
  });
}
function fmtKickoff(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles",
    }).format(new Date(iso)) + " PT";
  } catch { return ""; }
}
