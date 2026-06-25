import { NextResponse } from "next/server";
import { pool, ensureSchema, getState, syncFromFeed } from "../../../lib/db.js";
import { TEAMS, STAGES } from "../../../lib/teams.js";
import { validatePicks } from "../entries/route.js";

export const dynamic = "force-dynamic";

async function checkCode(p, code) {
  const r = await p.query(`SELECT commish_code FROM pool_config WHERE id = 1`);
  return r.rows[0]?.commish_code === String(code);
}

const tid = (name) => { const t = TEAMS.find((x) => x.name === name); return t ? t.id : 0; };

export async function POST(req) {
  try {
    await ensureSchema();
    const p = pool();
    const body = await req.json();
    const { action, code } = body;
    let syncResult = null;
    let editCode = null;

    if (!(await checkCode(p, code)))
      return NextResponse.json({ error: "Wrong commissioner code." }, { status: 401 });

    if (action === "auth") {
      // Code already validated above; unlock the commissioner UI by returning state.
    } else if (action === "pay") {
      await p.query(`UPDATE entries SET paid = NOT paid WHERE id = $1`, [body.id]);
    } else if (action === "deleteEntry") {
      await p.query(`DELETE FROM entries WHERE id = $1`, [body.id]);
    } else if (action === "editPicks") {
      // Commissioner override — works even when locked (the post-kickoff WhatsApp-request path).
      const picks = Array.isArray(body.picks) ? body.picks.map(Number) : [];
      const pickErr = validatePicks(picks);
      if (pickErr) return NextResponse.json({ error: pickErr }, { status: 400 });
      await p.query(`UPDATE entries SET picks = $1 WHERE id = $2`, [JSON.stringify(picks), body.id]);
    } else if (action === "revealCode") {
      const r = await p.query(`SELECT edit_code FROM entries WHERE id = $1`, [body.id]);
      if (!r.rows.length) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
      editCode = r.rows[0].edit_code || null;
    } else if (action === "config") {
      const c = body.config || {};
      await p.query(
        `UPDATE pool_config SET venmo_handle=$1, buy_in=$2, commish_code=$3, locked=$4, scoring=$5 WHERE id = 1`,
        [
          String(c.venmoHandle || "").replace(/^@/, ""),
          Number(c.buyIn) || 50,
          String(c.commishCode || "1986"),
          !!c.locked,
          JSON.stringify(c.scoring || {}),
        ]
      );
    } else if (action === "result") {
      const m = body.match || {};
      const stage = STAGES.find((s) => s.id === m.stage) ? m.stage : "group";
      const teamA = Number(m.teamA), teamB = Number(m.teamB);
      const scoreA = Number(m.scoreA), scoreB = Number(m.scoreB);
      let winner = m.winner == null || m.winner === "" ? null : Number(m.winner);
      if (teamA === teamB || !TEAMS[teamA] || !TEAMS[teamB])
        return NextResponse.json({ error: "Pick two different teams." }, { status: 400 });
      if (stage !== "group" && scoreA === scoreB && winner == null)
        return NextResponse.json({ error: "Knockout tie needs a winner." }, { status: 400 });
      const id = "m" + Date.now() + Math.floor(Math.random() * 99);
      await p.query(
        `INSERT INTO matches (id, stage, team_a, team_b, score_a, score_b, winner, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8)`,
        [id, stage, teamA, teamB, scoreA, scoreB, winner, Date.now()]
      );
    } else if (action === "editResult") {
      // Fix a previously-entered result in place. Editing a feed row converts it to
      // 'manual' so the live sync stops overwriting the commissioner's correction.
      const m = body.match || {};
      const stage = STAGES.find((s) => s.id === m.stage) ? m.stage : "group";
      const teamA = Number(m.teamA), teamB = Number(m.teamB);
      const scoreA = Number(m.scoreA), scoreB = Number(m.scoreB);
      let winner = m.winner == null || m.winner === "" ? null : Number(m.winner);
      if (teamA === teamB || !TEAMS[teamA] || !TEAMS[teamB])
        return NextResponse.json({ error: "Pick two different teams." }, { status: 400 });
      if (stage !== "group" && scoreA === scoreB && winner == null)
        return NextResponse.json({ error: "Knockout tie needs a winner." }, { status: 400 });
      const r = await p.query(
        `UPDATE matches SET stage=$1, team_a=$2, team_b=$3, score_a=$4, score_b=$5, winner=$6, source='manual', updated_at=$7 WHERE id=$8`,
        [stage, teamA, teamB, scoreA, scoreB, winner, Date.now(), body.id]
      );
      if (!r.rowCount) return NextResponse.json({ error: "Result not found." }, { status: 404 });
    } else if (action === "deleteMatch") {
      await p.query(`DELETE FROM matches WHERE id = $1`, [body.id]);
    } else if (action === "clearResults") {
      await p.query(`DELETE FROM matches`);
    } else if (action === "sample") {
      await p.query(`DELETE FROM matches`);
      const g = (a, sa, b, sb) => [tid(a), tid(b), sa, sb, "group", null];
      const k = (st, a, sa, b, sb, w) => [tid(a), tid(b), sa, sb, st, w ? tid(w) : null];
      const rows = [
        g("Spain", 3, "Cabo Verde", 0), g("France", 2, "Iraq", 1), g("Brazil", 1, "Morocco", 1),
        g("Argentina", 2, "Jordan", 0), g("England", 2, "Croatia", 2), g("Germany", 1, "Ecuador", 0),
        g("USA", 1, "Paraguay", 1), g("Mexico", 2, "South Africa", 1), g("Portugal", 3, "DR Congo", 1),
        g("Norway", 2, "Senegal", 1), g("Japan", 1, "Netherlands", 2),
        k("r32", "Spain", 2, "Uruguay", 0), k("r32", "France", 1, "Switzerland", 0),
        k("r16", "Spain", 1, "Germany", 1, "Spain"), k("qf", "France", 2, "Brazil", 1),
      ];
      for (const [a, b, sa, sb, st, w] of rows) {
        const id = "m" + Date.now() + Math.floor(Math.random() * 1e6);
        await p.query(
          `INSERT INTO matches (id, stage, team_a, team_b, score_a, score_b, winner, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8)`,
          [id, st, a, b, sa, sb, w, Date.now()]
        );
      }
    } else if (action === "koMatchup") {
      // Commissioner sets/clears a knockout matchup before the feed assigns teams (stored as an
      // override merged into the schedule at read time). Empty teams clears it.
      const fixtureId = String(body.fixtureId || "");
      if (!fixtureId) return NextResponse.json({ error: "Missing fixture." }, { status: 400 });
      const r = await p.query(`SELECT ko_overrides FROM pool_config WHERE id = 1`);
      const overrides = r.rows[0]?.ko_overrides || {};
      const aId = body.aId === "" || body.aId == null ? null : Number(body.aId);
      const bId = body.bId === "" || body.bId == null ? null : Number(body.bId);
      if (aId == null && bId == null) {
        delete overrides[fixtureId];
      } else if (aId == null || bId == null || !TEAMS[aId] || !TEAMS[bId] || aId === bId) {
        return NextResponse.json({ error: "Pick two different teams (or clear both to remove)." }, { status: 400 });
      } else {
        overrides[fixtureId] = { aId, bId };
      }
      await p.query(`UPDATE pool_config SET ko_overrides = $1 WHERE id = 1`, [JSON.stringify(overrides)]);
    } else if (action === "commentarySteer") {
      // Commissioner steers the booth's tone + feeds it freeform notes (no deploy needed).
      const steer = {
        tone: String(body.tone || "").slice(0, 500),
        notes: String(body.notes || "").slice(0, 2000),
      };
      await p.query(`UPDATE pool_config SET commentary_steer = $1 WHERE id = 1`, [JSON.stringify(steer)]);
    } else if (action === "sync") {
      syncResult = await syncFromFeed();
    } else {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    return NextResponse.json({ ...(await getState()), sync: syncResult, editCode });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
