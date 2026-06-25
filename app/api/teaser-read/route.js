import { NextResponse } from "next/server";
import { pool, ensureSchema } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

// Low-stakes confirmation that a player saw and acknowledged the Daily Picks teaser.
// Identity is the honor-system self-ID (same as the "who are you?" chip) — this only records a
// "read" timestamp for the commissioner's view, so it doesn't need the edit-code gate that the
// consequential picks writes use. We keep the FIRST acknowledgement (don't overwrite).
export async function POST(req) {
  try {
    await ensureSchema();
    const body = await req.json();
    const id = String(body.entryId || "");
    if (!id) return NextResponse.json({ error: "Missing entry." }, { status: 400 });
    await pool().query(
      `UPDATE entries SET teaser_read_at = $1 WHERE id = $2 AND teaser_read_at IS NULL`,
      [Date.now(), id]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
