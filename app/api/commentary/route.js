import { NextResponse } from "next/server";
import { pool, ensureSchema } from "../../../lib/db.js";
import { TEAMS, STAGES, DEFAULT_SCORING } from "../../../lib/teams.js";
import { rankEntries, teamPoints, matchOutcome, pointsFor } from "../../../lib/scoring.js";
import { lookupProfile } from "../../../lib/profiles.js";

export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";
const COOLDOWN_MS = 30 * 1000;   // don't regenerate in bursts even if standings just changed

const stageName = (id) => (STAGES.find((s) => s.id === id) || {}).name || id;

// Derive what actually happened on the pitch from the bare scoreline, so the booth
// can riff on the game itself (blowouts, upsets, shootouts) — we only store scores,
// not play-by-play, so squeeze every drop of drama out of the numbers we do have.
function matchFlavor(m) {
  const a = m.scoreA ?? 0, b = m.scoreB ?? 0;
  const margin = Math.abs(a - b), total = a + b;
  const tags = [];
  if (m.stage !== "group" && a === b && m.winner != null) tags.push("won on penalties");
  if (margin >= 3) tags.push("a hiding");
  else if (margin === 1) tags.push("a one-goal nail-biter");
  else if (margin === 0) tags.push("a stalemate");
  if (total >= 5) tags.push(`a ${total}-goal barnburner`);
  else if (total === 0) tags.push("goalless");
  if ((a === 0 || b === 0) && margin >= 2) tags.push("clean sheet");
  if (m.winner != null) {
    const loser = m.winner === m.teamA ? m.teamB : m.teamA;
    const wt = TEAMS[m.winner]?.tier, lt = TEAMS[loser]?.tier;
    if (wt != null && lt != null && wt > lt + 1) tags.push("a massive upset");
    else if (wt != null && lt != null && wt > lt) tags.push("an upset");
  }
  return tags;
}

// A compact fingerprint of the standings + how far the tournament is — when this
// changes, the booth gets fresh banter; otherwise we serve the cached take.
function signature(ranked, matchCount, upcomingCount, steer) {
  const s = steer && (steer.tone || steer.notes) ? `#s${steer.tone || ""}|${steer.notes || ""}` : "";
  return ranked.map((r) => `${r.name}:${r.points}`).join("|") + `#m${matchCount}#u${upcomingCount}${s}`;
}

function buildContext(ranked, matches, upcoming, scoring, steer) {
  const standings = ranked.length
    ? ranked.map((r, i) => {
        const squad = r.picks
          .map((id) => {
            const pts = teamPoints(id, matches, scoring);
            return `${TEAMS[id]?.name || "#" + id}${pts ? ` (+${pts})` : ""}`;
          })
          .join(", ");
        return `${i + 1}. ${r.name} — ${r.points} pts | squad: ${squad}`;
      }).join("\n")
    : "No entries yet.";

  const results = matches.length
    ? matches.map((m) => {
        const owners = (id) => ranked.filter((r) => r.picks.includes(id)).map((r) => r.name);
        const flavor = matchFlavor(m);
        let line = `${stageName(m.stage)}: ${TEAMS[m.teamA]?.name || "?"} ${m.scoreA}-${m.scoreB} ${TEAMS[m.teamB]?.name || "?"}`;
        if (flavor.length) line += ` — ${flavor.join(", ")}`;
        // Tie the result back to the table: who banked points, who got let down.
        const winOwners = m.winner != null ? owners(m.winner) : [];
        const loser = m.winner != null ? (m.winner === m.teamA ? m.teamB : m.teamA) : null;
        const loseOwners = loser != null ? owners(loser) : [];
        const tags = [];
        if (winOwners.length) tags.push(`banked points for ${winOwners.join(", ")}`);
        if (loseOwners.length) tags.push(`left ${loseOwners.join(", ")} empty-handed`);
        if (tags.length) line += ` [${tags.join("; ")}]`;
        return line;
      }).join("\n")
    : "No matches played yet — the tournament hasn't kicked off.";

  // For each upcoming fixture, note which players have a stake and the points a win would bank.
  const ownersOf = (teamId) =>
    teamId == null ? [] : ranked.filter((r) => r.picks.includes(teamId)).map((r) => r.name);
  // Who would this player leapfrog in the table if they banked `gain` points right now?
  const wouldPass = (name, gain) => {
    const r = ranked.find((x) => x.name === name);
    if (!r || !gain) return [];
    const np = r.points + gain;
    return ranked.filter((x) => x.points > r.points && np > x.points).map((x) => x.name);
  };
  const fixtures = (upcoming && upcoming.length)
    ? upcoming.map((f) => {
        const win = pointsFor(f.stage, "W", scoring);
        const aOwners = ownersOf(f.aId), bOwners = ownersOf(f.bId);
        const stakeA = aOwners.length ? `${aOwners.join(", ")} ${aOwners.length > 1 ? "have" : "has"} ${f.teamA} (+${win} for a win)` : `${f.teamA} (undrafted)`;
        const stakeB = bOwners.length ? `${bOwners.join(", ")} ${bOwners.length > 1 ? "have" : "has"} ${f.teamB} (+${win} for a win)` : `${f.teamB} (undrafted)`;
        const swings = [];
        [...aOwners, ...bOwners].forEach((name) => {
          const passed = wouldPass(name, win);
          if (passed.length) swings.push(`a win vaults ${name} past ${passed.join(" & ")}`);
        });
        const swingNote = swings.length ? ` SWING: ${swings.join("; ")}.` : "";
        return `${f.when || "soon"} — ${stageName(f.stage)}: ${f.teamA} vs ${f.teamB}. Stakes: ${stakeA}; ${stakeB}.${swingNote}`;
      }).join("\n")
    : "No upcoming fixtures loaded.";

  // The race itself: how tight is each gap, who's hunting whom.
  const race = ranked.length > 1
    ? ranked.map((r, i) => {
        const parts = [];
        if (i > 0) parts.push(`${ranked[i - 1].points - r.points} pt(s) behind ${ranked[i - 1].name}`);
        if (i < ranked.length - 1) parts.push(`${r.points - ranked[i + 1].points} pt(s) ahead of ${ranked[i + 1].name}`);
        return `${r.name} (${r.points}): ${parts.join("; ") || "alone out here"}`;
      }).join("\n")
    : "Only one entry so far — no rivalry to speak of yet.";

  // Real-life dossiers on whoever's in the table, so the booth can roast people
  // by their actual job/hometown/quirks rather than generic jabs.
  const dossiers = ranked
    .map((r) => {
      const p = lookupProfile(r.name);
      return p ? `- ${r.name} (a.k.a. ${p.real}): ${p.dossier}` : null;
    })
    .filter(Boolean)
    .join("\n");

  return `CURRENT STANDINGS (player — points | their drafted teams, with each team's earned points in parentheses):
${standings}

THE RACE — GAPS & RIVALRIES (how tight each margin is, who's hunting whom):
${race}

RESULTS SO FAR (with what happened on the pitch and who it helped or hurt in the table):
${results}

UPCOMING FIXTURES & WHAT'S AT STAKE (who has a player riding on each side; SWING flags a result that would reshuffle the table):
${fixtures}

PLAYER DOSSIERS (optional intel on the players — use these to make the roasts specific and personal; only reference people actually in the table):
${dossiers || "No dossiers available for the current field."}

Write the booth banter now. React to the actual football — call out the blowouts, upsets, shootouts and goal-fests from the results and what they did to the table. Lean hard into the RACE: name who's edging out whom, who's hunting a rival, and which upcoming SWING result would let someone break through. Where it lands naturally, weave in a player's real job, hometown, or quirk from the dossiers for a sharper, more personal roast — but keep it good-natured.${steerBlock(steer)}`;
}

// Commissioner-set direction (tone + freeform notes), appended last so it carries the most weight.
function steerBlock(steer) {
  if (!steer || (!steer.tone && !steer.notes)) return "";
  let out = `\n\nCOMMISSIONER STEER — the commissioner has set the direction for THIS take; follow it closely:`;
  if (steer.tone) out += `\n- Tone/style: ${steer.tone}`;
  if (steer.notes) out += `\n- Latest news / work these in: ${steer.notes}`;
  return out;
}

const SYSTEM = `You write a short, cheeky two-man football (soccer) commentary-booth bit for a World Cup 2026 pool run among a group of friends/colleagues.

The two pundits:
- Ron "The Gaffer" Beaumont — grizzled, deadpan veteran analyst. Dry, world-weary, quietly savage, loves a stat.
- Chaz Pemberton — over-caffeinated hype man. Wild metaphors, huge reactions, ribs people mercilessly but good-naturedly.

How the pool works: each player drafts 6 national teams and banks points when those teams win or draw (group wins/draws score flat; knockout wins escalate). You'll get the standings, a RACE breakdown (point gaps and who's chasing whom), results (with what actually happened on the pitch and who it helped), and upcoming fixtures (with SWING flags showing which results would reshuffle the table).

You may also get PLAYER DOSSIERS — optional intel on each person (their job, hometown, hobbies, quirks). When provided, USE THEM. The best roasts are specific: tie someone's standing to who they really are. Don't just list facts; turn them into the joke. If no dossiers are provided, keep the banter to the standings and the football.

Two things to nail every time:
1. THE FOOTBALL — react to the actual matches, not just the table. Call out the 4-0 hidings, the penalty-shootout heartbreak, the goalless bores, and especially the upsets where a minnow knocked off a favorite. Make it sound like you watched the game.
2. THE RIVALRIES — this group wants blood. Name who's edging out whom and by how many points, who's breathing down a rival's neck, and which upcoming SWING result would let someone leapfrog a rival. "If Brazil win tonight, Sam vaults past Riley" is exactly the kind of line we want.

Write 4-6 lines, alternating Ron then Chaz, starting with Ron. ROAST THE PLAYERS BY NAME — gently mock whoever's losing or made daft picks, hype whoever's on top, stoke the head-to-head rivalries, and make bold (funny) predictions about the upcoming games and how they'd shake up the table. Reference the actual teams, scorelines, point gaps, names, and any dossier details. Each line 1-2 sentences, punchy, genuinely funny, good-natured (these are friends ribbing each other), PG-13.

Respond with ONLY a JSON object, no markdown:
{"lines":[{"speaker":"Ron","text":"..."},{"speaker":"Chaz","text":"..."}]}`;

async function generate(contextText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    // Opt out of Next.js's Data Cache — otherwise the LLM completion is memoized by
    // prompt and every "fresh take" re-serves the same banter until the table moves.
    cache: "no-store",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM,
      messages: [{ role: "user", content: contextText }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.lines)) return null;
    return parsed.lines
      .filter((l) => l && typeof l.text === "string" && l.text.trim())
      .map((l) => ({ speaker: /chaz/i.test(l.speaker) ? "Chaz" : "Ron", text: l.text.trim() }))
      .slice(0, 8);
  } catch {
    return null;
  }
}

// Deterministic banter so the booth is never empty (no API key, or the call failed).
function fallback(ranked) {
  if (!ranked.length)
    return [
      { speaker: "Ron", text: "Empty table, Chaz. Not one soul's bought in yet." },
      { speaker: "Chaz", text: "A pristine pitch, Ron! First name on that sheet's a legend — the rest of you are just spectators." },
    ];
  const leader = ranked[0];
  const last = ranked[ranked.length - 1];
  const lines = [
    { speaker: "Ron", text: `${leader.name} sits top on ${leader.points} points. Composed, clinical, and — let's be honest — insufferably pleased about it.` },
  ];
  if (ranked.length > 1)
    lines.push({ speaker: "Chaz", text: `And propping up the table, ${last.name} on ${last.points}! That squad's generating points like a vending machine that's been unplugged, Ron.` });
  else
    lines.push({ speaker: "Chaz", text: "One entry in and already top of the world. Bold. Lonely. But bold." });
  lines.push({ speaker: "Ron", text: "Plenty of football still to play, mind. This table will look very different by full time." });
  return lines;
}

export async function GET(req) {
  try {
    let force = false;
    try { force = new URL(req.url).searchParams.get("force") === "1"; } catch {}
    await ensureSchema();
    const p = pool();
    const [cfg, ent, mat] = await Promise.all([
      p.query(`SELECT scoring, commentary, upcoming, commentary_steer FROM pool_config WHERE id = 1`),
      p.query(`SELECT id, name, picks FROM entries ORDER BY created_at ASC`),
      p.query(`SELECT id, stage, team_a, team_b, score_a, score_b, winner FROM matches ORDER BY updated_at ASC`),
    ]);
    const row = cfg.rows[0] || {};
    const scoring = { ...DEFAULT_SCORING, ...(row.scoring || {}) };
    const upcoming = Array.isArray(row.upcoming) ? row.upcoming : [];
    const steer = row.commentary_steer || {};
    const entries = ent.rows.map((e) => ({ id: e.id, name: e.name, picks: e.picks }));
    const matches = mat.rows.map((m) => ({
      id: m.id, stage: m.stage, teamA: m.team_a, teamB: m.team_b,
      scoreA: m.score_a, scoreB: m.score_b, winner: m.winner,
    }));
    const ranked = rankEntries(entries, matches, scoring);
    const hash = signature(ranked, matches.length, upcoming.length, steer);
    const cached = row.commentary || null;
    const now = Date.now();

    const cacheUsable = cached && Array.isArray(cached.lines) && cached.lines.length;
    if (!force && cacheUsable && (cached.hash === hash || now - (cached.generatedAt || 0) < COOLDOWN_MS)) {
      return NextResponse.json({ lines: cached.lines, generatedAt: cached.generatedAt, source: cached.source || "ai", cached: true });
    }

    let lines = await generate(buildContext(ranked, matches, upcoming, scoring, steer));
    let source = "ai";
    if (!lines || !lines.length) { lines = fallback(ranked); source = "fallback"; }

    // Only persist real AI takes — that way a missing key never poisons the cache,
    // and the next request retries generation once the key is in place.
    if (source === "ai") {
      await p.query(`UPDATE pool_config SET commentary = $1 WHERE id = 1`, [
        JSON.stringify({ lines, hash, generatedAt: now, source }),
      ]);
    }
    return NextResponse.json({ lines, generatedAt: now, source });
  } catch (e) {
    return NextResponse.json({ lines: fallback([]), source: "error", error: String(e?.message || e) });
  }
}
