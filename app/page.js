"use client";
import { useEffect, useRef } from "react";
import { mountApp } from "../lib/app-client";

const HTML = String.raw`

<div class="wrap">
  <header class="top">
    <div class="topbar"></div>
    <div class="hd-row">
      <div>
        <!-- Customize this header for your group. -->
        <div class="kicker">Your Group &nbsp;•&nbsp; World Cup 2026 &nbsp;•&nbsp; ⚽</div>
        <h1 class="brand">Group <span class="of">of</span> Death</h1>
        <p class="sub">A pool for your crew: draft one team from each of six tiers, then rack up points as they win, draw, and survive the knockouts. May the best bracket win.</p>
        <div class="cd-wrap">
          <div class="countdown" id="countdown"></div>
          <div class="pot-note" id="potNote"></div>
        </div>
      </div>
      <!-- Decorative emblem. Swap in your own crest/logo if you like. -->
      <div class="campanile" aria-hidden="true">
        <svg viewBox="0 0 80 224" xmlns="http://www.w3.org/2000/svg">
          <g fill="var(--pitch)">
            <path d="M22 36 h36 v10 a18 18 0 0 1-36 0 z"/>
            <path d="M22 36 a10 10 0 0 1-12 10 a10 10 0 0 0 12 6 z"/>
            <path d="M58 36 a10 10 0 0 0 12 10 a10 10 0 0 1-12 6 z"/>
            <rect x="37" y="62" width="6" height="14"/>
            <rect x="26" y="76" width="28" height="7" rx="2"/>
          </g>
          <circle cx="40" cy="150" r="22" fill="none" stroke="var(--pitch)" stroke-width="2.4"/>
          <path d="M40 134 l9 6.5 -3.4 10.5 h-11.2 L31 140.5 z" fill="#0a1730" stroke="var(--pitch)" stroke-width="1.6"/>
        </svg>
      </div>
    </div>
  </header>

  <nav class="tabs" id="tabs">
    <button data-tab="draft" class="active">Draft</button>
    <button data-tab="rosters">Rosters</button>
    <button data-tab="leaderboard">Leaderboard</button>
    <button data-tab="daily">Daily Picks</button>
    <button data-tab="results">Results</button>
    <button data-tab="admin">Commissioner</button>
  </nav>

  <div id="dailyNudge"></div>

  <div class="me-chip" id="meChip"></div>

  <!-- DRAFT -->
  <section id="draft" class="show">
    <details class="rules">
      <summary><span class="rules-tag">How it works</span> Read this before you draft <span class="rules-caret" aria-hidden="true">▾</span></summary>
      <div class="rules-body">
        <div class="rule-block">
          <h4>The gist</h4>
          <p>Draft one national team from each of the six tiers — six picks in all. You bank points every time one of your teams wins or draws. Group-stage results score flat; knockout wins escalate hard, so surviving deep into the bracket is where pools are won.</p>
        </div>
        <div class="rule-block">
          <h4>What you do</h4>
          <ol>
            <li>Pick one team in each of the six tiers — your <b>Ticket</b> fills in as you go.</li>
            <li>Add your name and email so the commissioner can reach you.</li>
            <li>Hit <b>Pay&nbsp;$50&nbsp;&amp;&nbsp;Submit</b> — you'll be sent to Venmo for the $50 buy-in. Your entry saves right away; the commissioner marks you paid once it lands.</li>
            <li>Join the group chat (link at the bottom) for results and trash talk.</li>
          </ol>
        </div>
        <div class="rule-block">
          <h4>Deadline</h4>
          <p>Picks lock at the opening whistle — <b>Thursday, June&nbsp;11, 2026, 12:00&nbsp;PM&nbsp;PT</b> (3:00&nbsp;PM&nbsp;ET). Get your six in and pay before then. No edits once the tournament kicks off.</p>
        </div>
        <div class="rule-block">
          <h4>Payouts</h4>
          <ul class="payouts">
            <li><span class="medal">🥇</span><span><b>Winner</b> takes the bulk of the prize pool. <span class="muted">(exact split TBD)</span></span></li>
            <li><span class="medal">🥈</span><span><b>Runner-up</b> doubles up — <b>$100</b> back on the $50 buy-in.</span></li>
            <li><span class="medal">🫥</span><span><b>Everyone else</b> waits four years for redemption. See you in 2030.</span></li>
          </ul>
        </div>
      </div>
    </details>
    <div class="h2" id="draftHead">Make your picks</div>
    <p class="lead" id="draftLead">One team per tier, six total. Tiers are set by tournament-winner odds — everyone gets one favorite and one prayer.</p>
    <div class="draft-grid">
      <div id="tierList"></div>
      <aside class="ticket">
        <div class="ticket-h"><b>Your Ticket</b><span id="slotCount">0 / 6</span></div>
        <div class="slots" id="slots"></div>
        <div class="ticket-form">
          <div id="newFields">
            <label class="fld">Your name</label>
            <input id="inName" placeholder="e.g. Ash" maxlength="28">
            <label class="fld">Email (so the commissioner can reach you)</label>
            <input id="inEmail" type="email" placeholder="you@example.com" autocomplete="email">
            <label class="fld">Venmo handle (for the buy-in)</label>
            <input id="inVenmo" placeholder="@your-handle">
          </div>
          <button class="btn btn-pay" id="submitBtn" disabled>Pay $50 &amp; Submit Picks</button>
          <button class="btn btn-ghost" id="cancelEditBtn" style="display:none;margin-top:8px">Cancel edit</button>
          <div class="pay-note" id="payNote">Pick 6 teams and add your name to continue.</div>
        </div>
      </aside>
    </div>
  </section>

  <!-- ROSTERS -->
  <section id="rosters">
    <div class="h2">The field</div>
    <p class="lead">Everyone who's bought in, and the six teams carrying their hopes.</p>
    <div id="editBar" class="edit-bar"></div>
    <div class="secnote">Prototype note: in this shared demo, rosters and Venmo handles are visible to all players. In the production build, contact + payment info is commissioner-only.</div>
    <div id="rosterList"></div>
  </section>

  <!-- LEADERBOARD -->
  <section id="leaderboard">
    <div class="h2">Leaderboard</div>
    <p class="lead">Live standings, scored from results below. Group wins and draws score flat; knockout wins escalate hard.</p>
    <div id="commentary" class="booth"></div>
    <div class="card" id="lbList"></div>
  </section>

  <!-- DAILY PICKS -->
  <section id="daily">
    <div class="h2">Daily Picks</div>
    <p class="lead">A second game — and a second pot — for the knockouts: pick the winner of every match, every day, $1 a pick, even after your drafted teams are out. Most correct by the final whistle takes the winner-takes-all pot. Picks don't move your main total, but they do break ties on the leaderboard. Each day locks at its first kickoff.</p>
    <div id="dailyList"></div>
  </section>

  <!-- RESULTS -->
  <section id="results">
    <div class="h2">Results</div>
    <p class="lead">The source of truth. In production this auto-syncs from a live feed (football-data.org) with a commissioner override. For now, results are entered in the Commissioner tab.</p>
    <div id="resultsList"></div>
  </section>

  <!-- ADMIN -->
  <section id="admin"></section>

  <footer class="foot">
    <div class="foot-card">
      <div>
        <div class="foot-k">Group channel</div>
        <div class="foot-t">Join the group chat</div>
        <div class="foot-s">Results, trash talk, and payout drama all live here. Make sure you're in the right conversation before kickoff.</div>
      </div>
      <!-- Replace this href with your own group-chat invite link (WhatsApp, Signal, etc.). -->
      <a class="wa-btn" href="https://chat.whatsapp.com/your-invite-code" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.69 5.522l-.999 3.648 3.808-.97zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
        Join group chat
      </a>
    </div>
  </footer>
</div>

<div class="flash" id="flash"></div>

`;

export default function Page() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    mountApp();
  }, []);
  return <div dangerouslySetInnerHTML={{ __html: HTML }} />;
}
