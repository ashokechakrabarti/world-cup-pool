import { NextResponse } from "next/server";
import { pool, ensureSchema, getState, applyKoOverrides } from "../../../lib/db.js";
import { TEAMS } from "../../../lib/teams.js";
import { KO_STAGES, gameDateOf, dailyLockFor } from "../../../lib/scoring.js";

export const dynamic = "force-dynamic";

// Knockout daily picks. Like self-service pick editing, ownership is proven by the per-entry
// 6-char edit code. These writes affect standings (secondary tiebreaker), so the code is required
// and the per-day lock is re-enforced server-side — a stale client can't sneak a pick in after lock.
//
//   mode "lookup": { entryId, editCode } -> { ok, picks: [{matchId, gameDate, winner, ou}] }
//   mode "submit": { entryId, editCode, picks: [{matchId, winner, ou}] } -> full state
//     ou is the optional Over/Under add-on bet: "over" | "under" | null (defaults null).
export async function POST(req) {
  try {
    await ensureSchema();
    const p = pool();
    const body = await req.json();
    const id = String(body.entryId || "");
    const editCode = String(body.editCode || "").trim().toUpperCase();
    const mode = body.mode === "submit" ? "submit" : "lookup";

    const row = await p.query(`SELECT edit_code FROM entries WHERE id = $1`, [id]);
    if (!row.rows.length) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    if (!editCode || row.rows[0].edit_code !== editCode)
      return NextResponse.json({ error: "Wrong edit code for this entry." }, { status: 401 });

    if (mode === "lookup") {
      const mine = await p.query(
        `SELECT match_id, game_date, predicted_winner, predicted_ou FROM daily_picks WHERE entry_id = $1`, [id]
      );
      return NextResponse.json({
        ok: true,
        picks: mine.rows.map((d) => ({ matchId: d.match_id, gameDate: d.game_date, winner: d.predicted_winner, ou: d.predicted_ou || null })),
      });
    }

    // ---- submit ----
    const incoming = Array.isArray(body.picks) ? body.picks : [];
    if (!incoming.length) return NextResponse.json({ error: "No picks submitted." }, { status: 400 });

    // Apply commissioner KO-matchup overrides so a manually-set fixture validates server-side too
    // (the client already sees the merged schedule; without this, picks on it get rejected).
    const cfgRow = await p.query(`SELECT schedule, ko_overrides FROM pool_config WHERE id = 1`);
    const schedule = applyKoOverrides(cfgRow.rows[0]?.schedule, cfgRow.rows[0]?.ko_overrides) || [];
    const fixtureById = new Map(schedule.map((f) => [f.id, f]));
    const now = Date.now();

    // Validate every pick before writing any — all-or-nothing.
    const clean = [];
    for (const raw of incoming) {
      const matchId = String(raw.matchId || "");
      const winner = Number(raw.winner);
      const ouRaw = raw.ou == null ? null : String(raw.ou).toLowerCase();
      const ou = ouRaw === "over" || ouRaw === "under" ? ouRaw : null;
      if (ouRaw && !ou)
        return NextResponse.json({ error: "Over/Under must be 'over' or 'under'." }, { status: 400 });
      const fx = fixtureById.get(matchId);
      if (!fx) return NextResponse.json({ error: `Unknown fixture: ${matchId}` }, { status: 400 });
      if (!KO_STAGES.has(fx.stage))
        return NextResponse.json({ error: "Daily picks are knockout-round only." }, { status: 400 });
      if (!Number.isInteger(winner) || !TEAMS[winner] || (winner !== fx.aId && winner !== fx.bId))
        return NextResponse.json({ error: "Pick one of the two teams in the fixture." }, { status: 400 });
      const gameDate = gameDateOf(fx.utcDate);
      const lock = dailyLockFor(schedule, gameDate);
      if (lock != null && now >= lock)
        return NextResponse.json({ error: "That day's slate is locked." }, { status: 403 });
      clean.push({ matchId, gameDate, winner, ou });
    }

    for (const c of clean) {
      await p.query(
        `INSERT INTO daily_picks (entry_id, match_id, game_date, predicted_winner, predicted_ou, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (entry_id, match_id) DO UPDATE SET
           predicted_winner = EXCLUDED.predicted_winner, predicted_ou = EXCLUDED.predicted_ou,
           updated_at = EXCLUDED.updated_at`,
        [id, c.matchId, c.gameDate, c.winner, c.ou, now]
      );
    }
    return NextResponse.json(await getState());
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
