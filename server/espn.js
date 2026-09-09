// ESPN Fantasy Football API client.
// Undocumented but well-known endpoint pattern. Private leagues require
// the espn_s2 and SWID cookies from an authenticated ESPN session.
//
// Env vars expected:
//   ESPN_S2       — value of the espn_s2 cookie
//   ESPN_SWID     — value of the SWID cookie (include the curly braces)
//   ESPN_LEAGUE_IDS — comma-separated list, e.g. "111111,222222,333333"
//   ESPN_SEASON   — e.g. "2026"
//   ESPN_TEAM_NAMES — comma-separated list of Bill's team name in EACH
//                     league (names can differ per league), e.g.
//                     "Spit on That Thang,Bud Light is Gross,..." — used
//                     to pick out his specific matchup from the several
//                     that exist in a league each week.

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
// NOTE: the read endpoint lives on lm-api-reads.fantasy.espn.com, not plain
// fantasy.espn.com — hitting the old domain gets silently redirected to
// ESPN's marketing homepage instead of returning API JSON (which then fails
// to parse with a confusing "Unexpected end of JSON input" error).
async function fetchLeague(leagueId) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mScoreboard&view=mTeam&view=mRoster&view=mSettings`;
  const cookie = cookieHeader();

  const headers = { ...BROWSER_HEADERS };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`ESPN league ${leagueId} fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // ESPN sometimes returns a 200 with an HTML page instead of a real API
    // error — catch that here with a clear message instead of letting
    // res.json() throw a confusing parse error.
    const preview = (await res.text()).slice(0, 200);
    throw new Error(`ESPN league ${leagueId}: expected JSON but got ${contentType || 'unknown content-type'}. Response starts: ${preview}`);
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

  // A league has one matchup PER PAIR OF TEAMS in a given period (a 12-team
  // league has 6 simultaneous matchups) — filtering by period alone returns
  // all of them, not just Bill's. Find his team by name, then pick only the
  // matchup he's actually in, rather than defaulting to whichever happens
  // to be first in ESPN's array.
  //
  // Only case and surrounding whitespace are normalized — a genuine typo
  // (a missing apostrophe, a misspelled word) should NOT silently match;
  // that's what the myTeamFound flag and "name not matched" UI tag are for.
  const normalizeTeamName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  const myTeamNames = (process.env.ESPN_TEAM_NAMES || '')
    .split(',')
    .map(normalizeTeamName)
    .filter(Boolean);

  const myTeam = Object.values(teamsById).find(t => myTeamNames.includes(normalizeTeamName(t.name)));

  const periodMatchups = (data.schedule || [])
    .filter(m => m.matchupPeriodId === data.status?.currentMatchupPeriod);

  const myMatchup = myTeam
    ? periodMatchups.find(m => m.home?.teamId === myTeam.id || m.away?.teamId === myTeam.id)
    : periodMatchups[0]; // fallback if we don't know Bill's team name in this league

  const matchups = myMatchup ? [myMatchup].map(m => {
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
  }) : [];

  return {
    leagueId,
    leagueName: data.settings?.name || `League ${leagueId}`,
    scoringPeriodId: currentPeriod,
    matchups,
    myTeamFound: !!myTeam,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAllLeagues() {
  if (!LEAGUE_IDS.length) {
    console.warn('[espn] ESPN_LEAGUE_IDS is empty — no leagues to fetch.');
    return [];
  }

  const results = [];
  for (const id of LEAGUE_IDS) {
    try {
      const league = await fetchLeague(id);
      console.log(`[espn] Fetched league ${id}: ${league.leagueName} (${league.matchups?.length || 0} matchups)`);
      results.push(league);
    } catch (err) {
      console.error(`[espn] League ${id} fetch failed: ${err.message}`);
      results.push({ leagueId: id, error: err.message });
    }
  }
  return results;
}

module.exports = { fetchAllLeagues, fetchLeague, LEAGUE_IDS };
