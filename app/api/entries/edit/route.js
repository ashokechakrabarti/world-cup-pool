import { NextResponse } from "next/server";
import { pool, ensureSchema, getState } from "../../../../lib/db.js";
import { validatePicks } from "../route.js";

export const dynamic = "force-dynamic";

// Self-service pick editing. Proof of ownership = the per-entry edit code.
// Frozen for everyone once the pool is locked (kickoff) — post-lock changes go through the commissioner.
export async function POST(req) {
  try {
    await ensureSchema();
    const p = pool();
    const body = await req.json();
    const id = String(body.entryId || "");
    const editCode = String(body.editCode || "").trim().toUpperCase();
    const mode = body.mode === "lookup" ? "lookup" : "update";

    const row = await p.query(`SELECT picks, edit_code FROM entries WHERE id = $1`, [id]);
    if (!row.rows.length) return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    if (!editCode || row.rows[0].edit_code !== editCode)
      return NextResponse.json({ error: "Wrong edit code for this entry." }, { status: 401 });

    // lookup: just hand back the current picks so the draft board can preload them.
    if (mode === "lookup") {
      return NextResponse.json({ ok: true, picks: row.rows[0].picks });
    }

    const cfg = await p.query(`SELECT locked FROM pool_config WHERE id = 1`);
    if (cfg.rows[0]?.locked)
      return NextResponse.json({ error: "Entries are locked — message the commissioner to change picks." }, { status: 403 });

    const picks = Array.isArray(body.picks) ? body.picks.map(Number) : [];
    const pickErr = validatePicks(picks);
    if (pickErr) return NextResponse.json({ error: pickErr }, { status: 400 });

    await p.query(`UPDATE entries SET picks = $1 WHERE id = $2`, [JSON.stringify(picks), id]);
    return NextResponse.json(await getState());
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
