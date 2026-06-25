// OPTIONAL player dossiers for the AI commentary booth (Ron & Chaz).
//
// These give the booth real, specific material so it can roast players by name with a
// nod to their actual job / hometown / quirks. This is the single most personal file in
// the project — it is NOT required for the app to run. With no entries here, the booth
// still works; it just keeps the banter to the standings and the football.
//
// HOW TO USE IT:
//   - Key each entry by the EXACT name a player types into their entry (see lookupProfile,
//     which also does a punctuation-insensitive fallback match).
//   - Keep `real` (their full name) and `dossier` (one or two sentences of roastable color).
//   - ONLY add details about people who have agreed to be in your private pool. Do not commit
//     real personal data to a public/forked repo.
//
// The two entries below are fictional placeholders — replace or delete them.

export const PROFILES = {
  "Sam": {
    real: "Sam Example",
    dossier: "A spreadsheet-obsessed product manager who insists every pick is 'data-driven' and yet drafts on vibes; coaches a kids' soccer team that has never won a game.",
  },
  "Riley": {
    real: "Riley Placeholder",
    dossier: "A perpetually late finance lead who joined the pool 30 seconds before lock, picked all favorites, and calls it 'risk management.'",
  },
};

// Match a pool entry's display name to a dossier. Exact first, then a case-insensitive,
// punctuation-stripped fallback so minor entry-name drift still resolves.
const norm = (s) => String(s || "").toLowerCase().replace(/["'']/g, "").replace(/\s+/g, " ").trim();
const BY_NORM = Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [norm(k), v]));

export function lookupProfile(name) {
  return PROFILES[name] || BY_NORM[norm(name)] || null;
}
