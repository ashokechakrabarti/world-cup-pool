import { NextResponse } from "next/server";
import { getState, syncFromFeed, pool, ensureSchema } from "../../../lib/db.js";
import { KICKOFF_ISO } from "../../../lib/teams.js";

export const dynamic = "force-dynamic";

const SYNC_INTERVAL_MS = 60 * 1000;   // free-tier rate limit is 10 req/min; one sync/min keeps the board fresh

export async function GET() {
  try {
    await ensureSchema();
    // Lazy sync: once the tournament is underway, refresh from the feed at most
    // every few minutes on read. Keeps free-tier hosting working without a cron.
    if (process.env.FOOTBALL_DATA_TOKEN && Date.now() > Date.parse(KICKOFF_ISO)) {
      const r = await pool().query(`SELECT last_synced FROM pool_config WHERE id = 1`);
      const last = Number(r.rows[0]?.last_synced || 0);
      if (Date.now() - last > SYNC_INTERVAL_MS) {
        try { await syncFromFeed(); } catch (e) { /* non-fatal */ }
      }
    }
    const state = await getState();
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
