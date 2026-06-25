import { NextResponse } from "next/server";
import { pool, ensureSchema, getState, genCode } from "../../../lib/db.js";
import { TEAMS, TIER_META } from "../../../lib/teams.js";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shared pick validation (used by create and edit). Returns an error string, or null if valid.
export function validatePicks(picks) {
  if (picks.length !== TIER_META.length || picks.some((x) => !Number.isInteger(x) || !TEAMS[x]))
    return "Pick one team per tier.";
  const tiers = picks.map((x) => TEAMS[x].tier).sort();
  if (tiers.join() !== TIER_META.map((_, i) => i).join())
    return "Pick exactly one team from each tier.";
  return null;
}

export async function POST(req) {
  try {
    await ensureSchema();
    const p = pool();
    const cfg = await p.query(`SELECT locked FROM pool_config WHERE id = 1`);
    if (cfg.rows[0]?.locked) {
      return NextResponse.json({ error: "Entries are locked." }, { status: 403 });
    }
    const body = await req.json();
    const name = String(body.name || "").trim().slice(0, 40);
    const email = String(body.email || "").trim();
    const venmo = String(body.venmo || "").trim().replace(/^@/, "");
    const picks = Array.isArray(body.picks) ? body.picks.map(Number) : [];

    if (!name) return NextResponse.json({ error: "Name required." }, { status: 400 });
    if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Valid email required." }, { status: 400 });
    const pickErr = validatePicks(picks);
    if (pickErr) return NextResponse.json({ error: pickErr }, { status: 400 });

    const id = "e" + Date.now() + Math.floor(Math.random() * 999);
    const editCode = genCode();
    await p.query(
      `INSERT INTO entries (id, name, email, venmo, paid, picks, created_at, edit_code)
       VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7)`,
      [id, name, email, venmo, JSON.stringify(picks), Date.now(), editCode]
    );
    return NextResponse.json({ ...(await getState()), entryId: id, editCode });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
