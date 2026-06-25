// Pure scoring helpers — shared by the client leaderboard and the server-side
// commentary route so both compute identical standings. No DOM, no DB.
import { DEFAULT_SCORING } from "./teams.js";

export function matchOutcome(m) {
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

export function pointsFor(stage, result, scoring = DEFAULT_SCORING) {
  if (result !== "W" && result !== "D") return 0;
  if (stage === "group") return result === "W" ? scoring.groupWin : scoring.groupDraw;
  if (result === "W") return scoring[stage] || 0;
  return 0;
}

export function teamPoints(teamId, matches, scoring = DEFAULT_SCORING) {
  let pts = 0;
  for (const m of matches) {
    if (m.teamA !== teamId && m.teamB !== teamId) continue;
    const r = matchOutcome(m)[teamId];
    if (r) pts += pointsFor(m.stage, r, scoring);
  }
  return pts;
}

export function entryPoints(entry, matches, scoring = DEFAULT_SCORING) {
  return entry.picks.reduce((a, id) => a + teamPoints(id, matches, scoring), 0);
}

// ---- knockout daily picks (secondary game) ----

// Stages that are part of the knockout bracket — the only fixtures eligible for daily picks.
export const KO_STAGES = new Set(["r32", "r16", "qf", "sf", "third", "final"]);

// The calendar date (Pacific) a fixture belongs to, as 'YYYY-MM-DD' — the daily-slate grouping key.
export function gameDateOf(utcDate) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles",
    }).format(new Date(utcDate));
  } catch { return ""; }
}

// Lock time (epoch ms) for a given game date = earliest kickoff among that day's knockout fixtures.
// Returns null if the date has no knockout fixtures in the schedule.
export function dailyLockFor(schedule, gameDate) {
  if (!Array.isArray(schedule)) return null;
  let earliest = null;
  for (const f of schedule) {
    if (!KO_STAGES.has(f.stage) || !f.utcDate) continue;
    if (gameDateOf(f.utcDate) !== gameDate) continue;
    const t = Date.parse(f.utcDate);
    if (!Number.isNaN(t) && (earliest == null || t < earliest)) earliest = t;
  }
  return earliest;
}

// Resolve each knockout fixture's winning team id, with manual (commissioner) results overriding the feed.
// Keyed by fixture id. Only fixtures with a decided winner appear.
export function winnerByMatchId(schedule, matches = []) {
  const out = {};
  const manual = {};
  for (const m of matches) {
    if (m.winner == null) continue;
    manual[`${m.stage}|${Math.min(m.teamA, m.teamB)}|${Math.max(m.teamA, m.teamB)}`] = m.winner;
  }
  for (const f of schedule || []) {
    if (!KO_STAGES.has(f.stage) || f.aId == null || f.bId == null) continue;
    const mk = `${f.stage}|${Math.min(f.aId, f.bId)}|${Math.max(f.aId, f.bId)}`;
    const w = manual[mk] != null ? manual[mk] : (f.winner != null ? f.winner : null);
    if (w != null) out[f.id] = w;
  }
  return out;
}

// Default Over/Under goal line for the daily O/U add-on bet, used when no real betting line is
// available (no odds key, or the line wasn't posted before lock). A half-line can't push.
export const OU_LINE = 2.5;

// Per-fixture O/U line, keyed by fixture id. Real consensus lines are snapshotted onto the
// schedule at lock (`f.ouLine`); fixtures without one fall back to OU_LINE.
export function ouLineByMatchId(schedule) {
  const out = {};
  for (const f of schedule || []) {
    if (!KO_STAGES.has(f.stage)) continue;
    out[f.id] = typeof f.ouLine === "number" ? f.ouLine : OU_LINE;
  }
  return out;
}

// Grade a total against a line. Returns "over" | "under" | "push". A whole-number line that the
// total lands exactly on is a push (no points either way); half-lines never push.
export function ouResult(totalGoals, line = OU_LINE) {
  if (totalGoals === line) return "push";
  return totalGoals > line ? "over" : "under";
}

// Total goals for decided knockout fixtures, keyed by fixture id, with manual (commissioner)
// scores overriding the feed. Only FINISHED fixtures with a score appear — O/U is never graded
// on a live or unplayed game. Goals are end-of-play (regulation + extra time); a penalty
// shootout is reflected only in the winner, never added to the goal total.
export function goalsByMatchId(schedule, matches = []) {
  const out = {};
  const manual = {};
  for (const m of matches) {
    if (m.scoreA == null || m.scoreB == null) continue;
    manual[`${m.stage}|${Math.min(m.teamA, m.teamB)}|${Math.max(m.teamA, m.teamB)}`] = m.scoreA + m.scoreB;
  }
  for (const f of schedule || []) {
    if (!KO_STAGES.has(f.stage) || f.aId == null || f.bId == null) continue;
    const mk = `${f.stage}|${Math.min(f.aId, f.bId)}|${Math.max(f.aId, f.bId)}`;
    if (manual[mk] != null) { out[f.id] = manual[mk]; continue; }
    if (f.status === "FINISHED" && f.scoreA != null && f.scoreB != null) out[f.id] = f.scoreA + f.scoreB;
  }
  return out;
}

// Secondary "daily picks" score for one entry: +1 per correctly predicted knockout winner,
// plus +1 per correct Over/Under call (the optional add-on bet) on the same fixture.
export function dailyScore(entryId, dailyPicks, schedule, matches = []) {
  const winners = winnerByMatchId(schedule, matches);
  const goals = goalsByMatchId(schedule, matches);
  const lines = ouLineByMatchId(schedule);
  let pts = 0;
  for (const d of dailyPicks) {
    if (d.entryId !== entryId) continue;
    if (winners[d.matchId] != null && winners[d.matchId] === d.winner) pts++;
    if (d.ou && goals[d.matchId] != null && ouResult(goals[d.matchId], lines[d.matchId]) === d.ou) pts++;
  }
  return pts;
}

// Per-entry breakdown for the daily-picks side game (the $1-per-pick pot). `points` is the same
// figure dailyScore() returns (winners + O/U), kept in lockstep; the rest powers the pot board,
// the hot-streak award, and the Wooden Spoon. picksMade = fixtures this entry picked = dollars in.
// Streak counts consecutive correct WINNER calls in kickoff order (O/U add-ons don't break it).
export function dailyStats(entryId, dailyPicks, schedule, matches = []) {
  const winners = winnerByMatchId(schedule, matches);
  const byId = {};
  for (const f of schedule || []) byId[f.id] = f;
  const mine = (dailyPicks || []).filter((d) => d.entryId === entryId && byId[d.matchId]);
  const ordered = mine
    .slice()
    .sort((a, b) => Date.parse(byId[a.matchId].utcDate || 0) - Date.parse(byId[b.matchId].utcDate || 0));
  let winnerCorrect = 0, winnerWrong = 0, decided = 0, streak = 0, best = 0;
  for (const d of ordered) {
    const w = winners[d.matchId];
    if (w == null) continue;   // not graded yet — doesn't count toward record or streak
    decided++;
    if (w === d.winner) { winnerCorrect++; streak++; if (streak > best) best = streak; }
    else { winnerWrong++; streak = 0; }
  }
  return {
    picksMade: mine.length,
    points: dailyScore(entryId, dailyPicks, schedule, matches),
    winnerCorrect, winnerWrong, decided,
    pending: mine.length - decided,
    bestStreak: best,
  };
}

// How many knockout fixtures have a graded winner — the denominator for "made all their picks"
// (the Wooden Spoon participation gate) and the pot board's record column.
export function decidedKoCount(schedule, matches = []) {
  const winners = winnerByMatchId(schedule, matches);
  return Object.keys(winners).length;
}

// Standings, highest first. Daily-picks sub-score breaks ties on main points; name is the final
// deterministic tiebreaker. Pass dailyPicks + schedule to enable the secondary sort/display.
export function rankEntries(entries, matches, scoring = DEFAULT_SCORING, dailyPicks = [], schedule = null) {
  return entries
    .map((e) => ({
      id: e.id, name: e.name, picks: e.picks,
      points: entryPoints(e, matches, scoring),
      daily: schedule ? dailyScore(e.id, dailyPicks, schedule, matches) : 0,
    }))
    .sort((a, b) => b.points - a.points || b.daily - a.daily || a.name.localeCompare(b.name));
}
