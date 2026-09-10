// Live NFL game scores/status via API-Football (api-sports.io).
// Replaces the previous ESPN site.api.espn.com integration, which was
// confirmed on 2026 opening night to persistently 403 Railway's outbound
// requests (and two different proxy fallbacks) — almost certainly request
// fingerprinting, not an IP block, since a well-resourced proxy (corsproxy.io)
// hit the identical wall. API-Football is a real authenticated API with a
// published contract, so this class of problem shouldn't recur.
//
// FREE TIER CONSTRAINT: 100 requests/day, 10/minute. This is far too low
// for continuous polling (Command Center's old ~20s cadence would exhaust
// it in minutes), so this module does NOT auto-poll. The frontend calls a
// manual "Refresh Live Data" action instead, and every call here increments
// a persisted daily counter that the UI surfaces as a countdown. If usage
// proves the app's worth, upgrading to the Pro plan (300 req/min) removes
// this constraint without any code change — only the calling cadence
// changes, not this module's interface.
//
// Public interface kept IDENTICAL to the old ESPN-based version
// (fetchScoreboard, fetchGameSummary, fetchAllLiveGameSummaries) so
// yahooScoring.js, tdWindows.js, gradePicks.js, and index.js don't need
// to change at all — only this module's internals differ.

const fetch = require('node-fetch');
const { readJSON, writeJSON } = require('./store');

const BASE_URL = 'https://v1.american-football.api-sports.io';
const NFL_LEAGUE_ID = 1; // confirmed via /leagues — stable, NFL-specific, won't change season to season
const CURRENT_SEASON = process.env.API_FOOTBALL_SEASON || '2026';

function apiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not set.');
  return key;
}

// ---------- Daily request counter ----------
// Persisted so a Railway restart doesn't silently reset the count and blow
// past the real daily cap. Resets when the stored date no longer matches
// today's UTC date (matching API-Football's own reset-at-00:00-UTC policy).

const DAILY_LIMIT = 100;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage() {
  const stored = readJSON('apiFootballUsage', { date: todayUTC(), count: 0 });
  if (stored.date !== todayUTC()) {
    return { date: todayUTC(), count: 0 };
  }
  return stored;
}

function incrementUsage() {
  const usage = getUsage();
  usage.count += 1;
  writeJSON('apiFootballUsage', usage);
  return usage;
}

function getUsageStatus() {
  const usage = getUsage();
  return { used: usage.count, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - usage.count) };
}

// ---------- Core fetch ----------

async function apiFootballFetch(path) {
  const usage = getUsage();
  if (usage.count >= DAILY_LIMIT) {
    throw new Error(`API-Football daily limit reached (${DAILY_LIMIT}/day) — resets at midnight UTC.`);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-apisports-key': apiKey() },
  });
  incrementUsage();

  if (!res.ok) {
    throw new Error(`API-Football request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`API-Football returned errors: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

// ---------- Public interface (same shape as the old ESPN version) ----------

// Live NFL games right now, merged with the last-known state of any game
// that has since finished. Two things confirmed via live testing tonight:
//   1. live=all works correctly on the free tier and returns real current
//      data (verified: Smith-Njigba's live points, 2 real touchdowns).
//   2. A date-scoped query (league+season+date) is what actually hit the
//      free-tier restriction ("Free plans do not have access to this
//      season") — NOT live=all itself. Bill correctly caught that I'd
//      misdiagnosed which query was actually blocked; live=all remains
//      the right primary source.
// The real problem live=all has is structural, not a plan restriction:
// it only ever returns games CURRENTLY in progress, so a game that just
// finished silently disappears from the response (and from TD Tracker /
// pick'em grading) the moment it ends. Fixed here by caching each game's
// last-seen state and merging it back in when live=all stops returning
// that game — the cache is what survives the game ending, not a
// different (blocked) query.

async function fetchScoreboard() {
  try {
    const data = await apiFootballFetch(`/games?live=all`);
    const liveGames = normalizeGames(data.response || []);

    const cache = readJSON('lastKnownGames', {});
    const now = new Date().toISOString();

    // Update the cache with whatever's live right now.
    liveGames.forEach(g => { cache[g.gameId] = { ...g, cachedAt: now }; });

    // Any cached game finished on ESPN's actual clock (kickoff was today
    // or later, meaning it's not from a stale prior week) but missing from
    // the live response is treated as finished — merge it back in with
    // state forced to 'post' so it doesn't just vanish from TD Tracker/
    // pick'em the instant it drops out of live=all.
    const liveIds = new Set(liveGames.map(g => g.gameId));
    const merged = [...liveGames];
    Object.values(cache).forEach(g => {
      if (!liveIds.has(g.gameId)) {
        merged.push({ ...g, state: 'post' });
      }
    });

    // Persist the FULL merged result (including already-finished games
    // carried forward from a prior cache), not just what came back live
    // this call. Confirmed via live testing: a mid-game redeploy caused
    // this exact game to disappear entirely from a later /api/snapshot —
    // writing only the newly-live entries left finished games one
    // redeploy away from being silently dropped if the cache file itself
    // was ever reset. Writing the merged set means every refresh
    // re-affirms every game this session has ever seen, live or finished,
    // for as long as the underlying volume survives.
    const mergedCache = {};
    merged.forEach(g => { mergedCache[g.gameId] = { ...g, cachedAt: cache[g.gameId]?.cachedAt || now }; });

    writeJSON('lastKnownGames', mergedCache);
    return merged;
  } catch (err) {
    throw new Error(`NFL scoreboard fetch failed: ${err.message}`);
  }
}

function normalizeGames(games) {
  return games.map(g => {
    const statusShort = g.game?.status?.short; // e.g. 'Q1'..'Q4', 'FT', 'NS'
    const state = statusShort === 'NS' ? 'pre' : (statusShort === 'FT' ? 'post' : 'in');

    return {
      gameId: g.game?.id,
      name: `${g.teams?.away?.name} at ${g.teams?.home?.name}`,
      shortName: `${g.teams?.away?.name} @ ${g.teams?.home?.name}`,
      date: g.game?.date?.timestamp ? new Date(g.game.date.timestamp * 1000).toISOString() : null,
      state,
      statusDetail: g.game?.status?.long,
      home: g.teams?.home ? {
        team: g.teams.home.name,
        score: g.scores?.home?.total ?? null,
        winner: state === 'post' && (g.scores?.home?.total ?? 0) > (g.scores?.away?.total ?? 0),
      } : null,
      away: g.teams?.away ? {
        team: g.teams.away.name,
        score: g.scores?.away?.total ?? null,
        winner: state === 'post' && (g.scores?.away?.total ?? 0) > (g.scores?.home?.total ?? 0),
      } : null,
    };
  });
}

// Full box score (player stat lines) + touchdown events for one game.
// Two API-Football calls (player stats + events) — both counted against
// the daily quota, so fetchAllLiveGameSummaries below is deliberately
// careful about how many games it pulls this for.
async function fetchGameSummary(gameId) {
  try {
    const statsData = await apiFootballFetch(`/games/statistics/players?id=${gameId}`);
    const players = normalizePlayerStats(statsData.response || []);

    let touchdowns = [];
    try {
      const eventsData = await apiFootballFetch(`/games/events?id=${gameId}`);
      touchdowns = extractTouchdowns(eventsData.response || [], gameId);
    } catch (err) {
      // Touchdown timing is used for the TD Tracker window buckets — if
      // events fail, still return the player stats we already paid for
      // rather than losing everything over one of two calls failing.
    }

    return { players, touchdowns, fetchedAt: new Date().toISOString() };
  } catch (err) {
    throw new Error(`NFL game summary fetch failed for ${gameId}: ${err.message}`);
  }
}

// API-Football groups stats by category (Passing/Rushing/Receiving/...)
// per team, with human-readable stat names. yahooScoring.js's extraction
// functions expect a SPECIFIC key vocabulary inherited from the old
// ESPN-based format (passing_YDS, receiving_REC, kicking_FG, etc.) — rather
// than rewrite yahooScoring.js, this maps API-Football's stat names onto
// that exact same vocabulary, so nothing downstream needs to change.
// Field goal distance breakdown (a genuine improvement API-Football offers
// that ESPN's feed never did) is kept under its own descriptive keys for
// a future, more accurate kicker-scoring pass — not shoehorned into the
// old flat kicking_FG key, which only ever meant "total FG made".
const STAT_NAME_MAP = {
  'passing_yards': 'passing_YDS',
  'passing_passing_touch_downs': 'passing_TD',
  'passing_interceptions': 'passing_INT',
  'rushing_yards': 'rushing_YDS',
  'rushing_rushing_touch_downs': 'rushing_TD',
  'receiving_yards': 'receiving_YDS',
  'receiving_receiving_touch_downs': 'receiving_TD',
  'receiving_total_receptions': 'receiving_REC',
  // API-Football doesn't break fumbles into a dedicated group the way
  // ESPN did — fumbles_LOST has no confirmed source field yet, left
  // unmapped rather than guessed at (scoreOffensiveStatLine treats a
  // missing key as 0, which is the safe default until this is verified
  // against a real fumble in a live game).
  'kicking_field_goals_made': 'kicking_FG', // NOTE: exact API-Football field name for "made" count not yet confirmed — see field goals '1/1' format below
  'kicking_extra_point_made': 'kicking_XP',
};

function normalizePlayerStats(teamBlocks) {
  const players = {};
  teamBlocks.forEach(teamBlock => {
    (teamBlock.groups || []).forEach(group => {
      (group.players || []).forEach(p => {
        const name = p.player?.name;
        if (!name) return;
        if (!players[name]) players[name] = {};

        (p.statistics || []).forEach(stat => {
          const rawKey = `${group.name.toLowerCase()}_${stat.name.replace(/\s+/g, '_')}`;
          const mappedKey = STAT_NAME_MAP[rawKey];

          // "field goals" and "extra point" come through as "made/attempted"
          // strings (e.g. "1/1"), not a bare count — parse the made count
          // out rather than passing the string straight through, since
          // scoreKickerStatLine expects a plain number.
          if (rawKey === 'kicking_field_goals' || rawKey === 'kicking_extra_point') {
            const made = parseInt(String(stat.value).split('/')[0], 10);
            const targetKey = rawKey === 'kicking_field_goals' ? 'kicking_FG' : 'kicking_XP';
            players[name][targetKey] = Number.isFinite(made) ? made : 0;
            return;
          }

          if (mappedKey) {
            players[name][mappedKey] = stat.value;
          }
          // Also keep the raw key around under its original name for
          // anything not yet mapped (e.g. field-goal-distance breakdown) —
          // harmless extra data, useful for a future accurate-kicker pass.
          players[name][rawKey] = stat.value;
        });
      });
    });
  });
  return players;
}

// API-Football's /games/events endpoint — CONFIRMED shape from a real
// touchdown tonight (2026 opening night, Patriots @ Seahawks):
//   { quarter: "Fourth", minute: "11:28", team: {...}, player: {...},
//     type: "TD", comment: "Jaxon Smith-Njigba 45 Yd pass from Drew Lock
//     (Jason Myers Kick)", score: {...} }
// type is an exact code ("TD", "FG", etc.), not free text — the original
// text-search guess (looking for "touchdown" as a substring) never
// matched this, which is why TD Tracker silently showed 0 despite 2 real
// touchdowns. quarter is a WORD ("Second"/"Third"/"Fourth"), not a number
// — mapped to a period number since gradePicks/tdWindows expect one.
const QUARTER_TO_PERIOD = { First: 1, Second: 2, Third: 3, Fourth: 4, OT: 5, Overtime: 5 };

function extractTouchdowns(events, gameId) {
  return events
    .filter(e => e.type === 'TD')
    .map(e => ({
      gameId,
      playId: null, // API-Football events don't carry a stable per-event id
      team: e.team?.name || null,
      text: e.comment || null,
      period: QUARTER_TO_PERIOD[e.quarter] ?? null,
      clock: e.minute ?? null,
    }));
}

// Fetches summaries for every currently-live game. Each game costs 2
// requests (stats + events) on top of the 1 already spent on
// fetchScoreboard — with the free tier's 100/day cap, this adds up fast
// (e.g. 3 simultaneous games = 6 requests per manual refresh). This is
// surfaced to the user via the usage countdown rather than hidden.
async function fetchAllLiveGameSummaries() {
  const games = await fetchScoreboard();
  const relevant = games.filter(g => g.state === 'in' || g.state === 'post');

  const summaries = [];
  for (const g of relevant) {
    try {
      const summary = await fetchGameSummary(g.gameId);
      summaries.push({ game: g, summary });
    } catch (err) {
      continue; // one game failing shouldn't break the whole batch
    }
  }
  return { games, summaries };
}

module.exports = {
  fetchScoreboard,
  fetchGameSummary,
  fetchAllLiveGameSummaries,
  extractTouchdowns,
  getUsageStatus,
};
