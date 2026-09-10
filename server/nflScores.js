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

// Live NFL games right now. Uses live=all rather than a date query since
// that's what actually returned real in-progress data during testing —
// date-only queries returned empty results even for a known-live date,
// for reasons not fully understood (likely a timezone/date-boundary quirk
// in how API-Football scopes "today"). live=all sidesteps that ambiguity
// entirely for the in-progress case, which is what Command Center needs
// most; a completed-game catch-up path is handled separately if needed.
async function fetchScoreboard() {
  try {
    const data = await apiFootballFetch(`/games?live=all`);
    return normalizeGames(data.response || []);
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

// API-Football's /games/events endpoint returns a play-by-play list;
// touchdown-scoring plays are identified by the event `type`/`comment`
// containing "TD" or "Touchdown" — the exact field naming wasn't fully
// confirmed during evaluation (evaluation quota was limited), so this
// errs toward checking multiple plausible fields rather than assuming one.
function extractTouchdowns(events, gameId) {
  return events
    .filter(e => {
      const text = `${e.type || ''} ${e.comment || ''}`.toLowerCase();
      return text.includes('touchdown') || text.includes(' td ') || text.endsWith(' td');
    })
    .map(e => ({
      gameId,
      playId: e.id ?? null,
      team: e.team?.name || null,
      text: e.comment || e.type || null,
      period: e.quarter ?? null,
      clock: e.time ?? null,
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
