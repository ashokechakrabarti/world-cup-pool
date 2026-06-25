// Single source of truth for teams (ORDER MATTERS — entry picks store the index).
// Assembled from 2026 World Cup winner odds (tiers) + the confirmed group draw.

export const TIER_META = [
  { n: "Tier 1", d: "The favorites", c: "var(--t1)" },
  { n: "Tier 2", d: "Contenders",    c: "var(--t2)" },
  { n: "Tier 3", d: "Dark horses",   c: "var(--t3)" },
  { n: "Tier 4", d: "Mid-pack",      c: "var(--t4)" },
  { n: "Tier 5", d: "Underdogs",     c: "var(--t5)" },
  { n: "Tier 6", d: "Longshots",     c: "var(--t6)" },
];

const RAW = [
  // Tier 1
  ["Spain","🇪🇸","H",0],["France","🇫🇷","I",0],["England","🏴","L",0],["Portugal","🇵🇹","K",0],
  ["Argentina","🇦🇷","J",0],["Brazil","🇧🇷","C",0],["Germany","🇩🇪","E",0],["Netherlands","🇳🇱","F",0],
  // Tier 2
  ["Belgium","🇧🇪","G",1],["Norway","🇳🇴","I",1],["Colombia","🇨🇴","K",1],["Uruguay","🇺🇾","H",1],
  ["Croatia","🇭🇷","L",1],["Senegal","🇸🇳","I",1],["Morocco","🇲🇦","C",1],["Switzerland","🇨🇭","B",1],
  // Tier 3
  ["Mexico","🇲🇽","A",2],["USA","🇺🇸","D",2],["Japan","🇯🇵","F",2],["Ecuador","🇪🇨","E",2],
  ["Ivory Coast","🇨🇮","E",2],["Egypt","🇪🇬","G",2],["Austria","🇦🇹","J",2],["Sweden","🇸🇪","F",2],
  // Tier 4
  ["Australia","🇦🇺","D",3],["Canada","🇨🇦","B",3],["Scotland","🏴","C",3],["Algeria","🇩🇿","J",3],
  ["South Korea","🇰🇷","A",3],["Paraguay","🇵🇾","D",3],["Türkiye","🇹🇷","D",3],["Panama","🇵🇦","L",3],
  // Tier 5
  ["Qatar","🇶🇦","B",4],["Tunisia","🇹🇳","F",4],["Iran","🇮🇷","G",4],["Ghana","🇬🇭","L",4],
  ["Uzbekistan","🇺🇿","K",4],["Cabo Verde","🇨🇻","H",4],["Saudi Arabia","🇸🇦","H",4],["Czechia","🇨🇿","A",4],
  // Tier 6
  ["Bosnia & Herz.","🇧🇦","B",5],["Jordan","🇯🇴","J",5],["South Africa","🇿🇦","A",5],["New Zealand","🇳🇿","G",5],
  ["Iraq","🇮🇶","I",5],["DR Congo","🇨🇩","K",5],["Curaçao","🇨🇼","E",5],["Haiti","🇭🇹","C",5],
];

export const TEAMS = RAW.map((t, i) => ({ id: i, name: t[0], flag: t[1], group: t[2], tier: t[3] }));

export const STAGES = [
  { id: "group", name: "Group Stage" },
  { id: "r32",   name: "Round of 32" },
  { id: "r16",   name: "Round of 16" },
  { id: "qf",    name: "Quarterfinal" },
  { id: "sf",    name: "Semifinal" },
  { id: "final", name: "Final" },
];

export const DEFAULT_SCORING = { groupWin: 3, groupDraw: 1, r32: 4, r16: 6, qf: 10, sf: 15, final: 25 };

// Mexico vs South Africa, Estadio Azteca — first kickoff (ET).
export const KICKOFF_ISO = "2026-06-11T15:00:00-04:00";

/* ----- Feed name resolution (football-data.org -> our team index) ----- */
const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");

// Aliases the feed may use that differ from our display names.
const ALIASES = {
  unitedstates: "USA", usmnt: "USA",
  korearepublic: "South Korea", republicofkorea: "South Korea", southkorea: "South Korea",
  turkiye: "Türkiye", turkey: "Türkiye",
  iriran: "Iran", iran: "Iran",
  cotedivoire: "Ivory Coast", ivorycoast: "Ivory Coast",
  congodr: "DR Congo", drcongo: "DR Congo", democraticrepublicofcongo: "DR Congo", drcongotbd: "DR Congo",
  bosniaandherzegovina: "Bosnia & Herz.", bosniaherzegovina: "Bosnia & Herz.",
  caboverde: "Cabo Verde", capeverde: "Cabo Verde",
  capeverdeislands: "Cabo Verde", caboverdeislands: "Cabo Verde",   // football-data.org uses "Cape Verde Islands"
  czechrepublic: "Czechia", czechia: "Czechia",
  curacao: "Curaçao",
  saudiarabia: "Saudi Arabia",
  newzealand: "New Zealand",
  southafrica: "South Africa",
};

const BY_NORM = (() => {
  const m = {};
  TEAMS.forEach((t) => { m[norm(t.name)] = t.id; });
  Object.entries(ALIASES).forEach(([k, name]) => {
    const t = TEAMS.find((x) => x.name === name);
    if (t) m[norm(k)] = t.id;
  });
  return m;
})();

export function resolveTeam(name) {
  const id = BY_NORM[norm(name)];
  return id === undefined ? null : id;
}

// football-data.org stage enum -> our stage id
export const STAGE_MAP = {
  GROUP_STAGE: "group",
  LAST_32: "r32",
  ROUND_OF_32: "r32",
  LAST_16: "r16",
  ROUND_OF_16: "r16",
  QUARTER_FINALS: "qf",
  QUARTER_FINAL: "qf",
  SEMI_FINALS: "sf",
  SEMI_FINAL: "sf",
  FINAL: "final",
};
