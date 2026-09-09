// ESPN Fantasy Football API client.
// Undocumented but well-known endpoint pattern. Private leagues require
// the espn_s2 and SWID cookies from an authenticated ESPN session.
//
// Env vars expected:
//   ESPN_S2       — value of the espn_s2 cookie
//   ESPN_SWID     — value of the SWID cookie (include the curly braces)
//   ESPN_LEAGUE_IDS — comma-separated list, e.g. "111111,222222,333333"
//   ESPN_SEASON   — e.g. "2026"

const fetch = require('node-fetch');

const SEASON = process.env.ESPN_SEASON || '2026';
const LEAGUE_IDS = (process.env.ESPN_LEAGUE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

function cookieHeader() {
  const s2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;
  if (!s2 || !swid) return null;
  return `espn_s2=${s2}; SWID=${swid};`;
}

// mMatchupScore + mScoreboard gives live scoring for the current matchup period.
async function fetchLeague(leagueId) {
  const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mScoreboard&view=mTeam&view=mRoster`;
  const cookie = cookieHeader();

  const headers = { ...BROWSER_HEADERS };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`ESPN league ${leagueId} fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return normalizeLeague(leagueId, data);
}

function normalizeLeague(leagueId, data) {
  const teamsById = {};
  (data.teams || []).forEach(t => {
    teamsById[t.id] = {
      id: t.id,
      name: (t.location && t.nickname) ? `${t.location} ${t.nickname}`.trim() : (t.name || `Team ${t.id}`),
      abbrev: t.abbrev,
    };
  });

  const currentPeriod = data.scoringPeriodId;

  const matchups = (data.schedule || [])
    .filter(m => m.matchupPeriodId === data.status?.currentMatchupPeriod)
    .map(m => {
      const home = m.home || {};
      const away = m.away || {};
      return {
        matchupId: m.id,
        home: {
          teamId: home.teamId,
          teamName: teamsById[home.teamId]?.name || `Team ${home.teamId}`,
          score: home.totalPoints ?? home.pointsByScoringPeriod?.[currentPeriod] ?? null,
        },
        away: away.teamId != null ? {
          teamId: away.teamId,
          teamName: teamsById[away.teamId]?.name || `Team ${away.teamId}`,
          score: away.totalPoints ?? away.pointsByScoringPeriod?.[currentPeriod] ?? null,
        } : null,
      };
    });

  return {
    leagueId,
    leagueName: data.settings?.name || `League ${leagueId}`,
    scoringPeriodId: currentPeriod,
    matchups,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAllLeagues() {
  const results = [];
  for (const id of LEAGUE_IDS) {
    try {
      const league = await fetchLeague(id);
      results.push(league);
    } catch (err) {
      results.push({ leagueId: id, error: err.message });
    }
  }
  return results;
}

module.exports = { fetchAllLeagues, fetchLeague, LEAGUE_IDS };
