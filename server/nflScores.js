// Live NFL game scores/status via ESPN's public scoreboard API.
// No authentication required. Used for:
//   - grading pick'em and survivor picks (green/red)
//   - powering the Yahoo fantasy live-scoring estimate (via player box scores)

const fetch = require('node-fetch');

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// ESPN's edge network rejects requests with no User-Agent (or an obvious
// bot-like default one) with a 403. A standard browser UA gets through fine
// most of the time, though under heavy real-world load (e.g. opening night)
// ESPN's anti-bot/rate-limiting may reject even well-formed requests from
// cloud/datacenter IP ranges intermittently — the retry below is aimed at
// that intermittent case specifically, not a hard permanent block.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.espn.com/',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`${res.status} ${res.statusText}`);
      // Only worth retrying on likely-transient statuses — a real 404 or
      // similar client error won't fix itself on retry.
      if (res.status !== 403 && res.status !== 429 && res.status < 500) {
        throw lastError;
      }
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(500 * (i + 1)); // 500ms, then 1000ms
  }
  throw lastError;
}

async function fetchScoreboard() {
  try {
    const res = await fetchWithRetry(SCOREBOARD_URL, { headers: BROWSER_HEADERS });
    const data = await res.json();
    return normalizeScoreboard(data);
  } catch (err) {
    throw new Error(`NFL scoreboard fetch failed: ${err.message}`);
  }
}

function normalizeScoreboard(data) {
  return (data.events || []).map(ev => {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');

    return {
      gameId: ev.id,
      name: ev.name,
      shortName: ev.shortName,
      date: ev.date, // ISO kickoff time — used to bucket into AM/PM/night windows
      state: comp?.status?.type?.state, // 'pre' | 'in' | 'post'
      statusDetail: comp?.status?.type?.shortDetail,
      home: home ? {
        team: home.team?.abbreviation,
        score: home.score != null ? Number(home.score) : null,
        winner: !!home.winner,
      } : null,
      away: away ? {
        team: away.team?.abbreviation,
        score: away.score != null ? Number(away.score) : null,
        winner: !!away.winner,
      } : null,
    };
  });
}

// Full box score (individual player stat lines) + scoring plays for one
// game. Updates live. Returns both since the touchdown tracker and the
// Yahoo scoring engine both need this same endpoint's data.
async function fetchGameSummary(gameId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${gameId}`;
  try {
    const res = await fetchWithRetry(url, { headers: BROWSER_HEADERS });
    const data = await res.json();
    const boxScore = normalizeBoxScore(data);
    const touchdowns = extractTouchdowns(data, gameId);
    return { ...boxScore, touchdowns };
  } catch (err) {
    throw new Error(`NFL game summary fetch failed for ${gameId}: ${err.message}`);
  }
}

// Pulls every player's stat line out of ESPN's boxscore payload into a flat,
// name-keyed lookup: { "Patrick Mahomes": { passingYards, passingTDs, ... }, ... }
function normalizeBoxScore(data) {
  const players = {};
  const teams = data.boxscore?.players || [];

  teams.forEach(teamBlock => {
    (teamBlock.statistics || []).forEach(statCategory => {
      // statCategory.name is like 'passing', 'rushing', 'receiving', 'fumbles'
      const labels = statCategory.labels || [];
      (statCategory.athletes || []).forEach(a => {
        const name = a.athlete?.displayName;
        if (!name) return;
        if (!players[name]) players[name] = {};
        const stats = a.stats || [];
        labels.forEach((label, i) => {
          players[name][`${statCategory.name}_${label}`] = stats[i];
        });
      });
    });
  });

  return { players, fetchedAt: new Date().toISOString() };
}

// Extracts touchdown scoring plays from a game summary. ESPN's `scoringPlays`
// array lists every scoring play in the game with a `scoringType.abbreviation`
// (e.g. "TD", "FG", "SF") — filtering to TD gives an ordered list of every
// touchdown scored, with the team and a timestamp we can use to know it's new.
function extractTouchdowns(data, gameId) {
  const plays = data.scoringPlays || [];
  return plays
    .filter(p => p.scoringType?.abbreviation === 'TD')
    .map(p => ({
      gameId,
      playId: p.id,
      team: p.team?.abbreviation || null,
      text: p.text || null,
      period: p.period?.number ?? null,
      clock: p.clock?.displayValue ?? null,
    }));
}

module.exports = { fetchScoreboard, fetchGameSummary, extractTouchdowns, fetchAllLiveGameSummaries };

// Fetches every in-progress or completed game's full summary (box score +
// touchdowns) in one pass. Both the Yahoo scoring engine and the TD window
// tracker need this same data — computing it once per poll cycle and sharing
// it avoids doubling ESPN API calls.
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
