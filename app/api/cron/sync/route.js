import { NextResponse } from "next/server";
import { syncFromFeed } from "../../../../lib/db.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const url = new URL(req.url);
    if (auth !== `Bearer ${secret}` && url.searchParams.get("key") !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const r = await syncFromFeed();
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
