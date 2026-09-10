const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const { readJSON, writeJSON } = require('./store');
const tracking = require('./tracking');
const espn = require('./espn');
const nflScores = require('./nflScores');
const vision = require('./vision');
const yahooScoring = require('./yahooScoring');
const gradePicks = require('./gradePicks');
const tdWindows = require('./tdWindows');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Tracking toggle ----------

app.get('/api/tracking', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json(tracking.getState());
});

app.post('/api/tracking', (req, res) => {
  const { on } = req.body;
  const state = tracking.setTracking(on);
  res.json(state);
});

// ---------- Live data snapshot ----------
// The frontend polls this single endpoint on its interval. When tracking is
// off, this still responds (cheaply, from cache) so the UI can show the last
// known snapshot without hitting any upstream API.

let lastSnapshot = readJSON('lastSnapshot', null);

// Live NFL data (scores, box scores, TD windows) is now paid-API-Football
// backed with a hard 100/day free-tier cap — this can NOT be fetched on
// every /api/snapshot poll the way ESPN's free feed once was. It's cached
// here and only refreshed when the user explicitly taps "Refresh Live
// Data", via /api/refresh-nfl-data below. Every /api/snapshot call reuses
// whatever's cached here (possibly stale) rather than triggering a new
// API-Football request itself.
let cachedNflData = readJSON('cachedNflData', { games: [], summaries: [], gameDataError: null, fetchedAt: null });

// Returns the stored weekly data as-is if it matches the current NFL week,
// or null (treated as "not captured yet") if it's from a prior week —
// automatic weekly reset without deleting anything, so the underlying file
// on disk is untouched if this guess ever needs to be revisited.
//
// Deliberately conservative: if we don't know the current week (ESPN fetch
// failed) or the stored data has no week number at all (an older capture,
// or the vision extraction couldn't read one), we keep showing it rather
// than risk wiping real data over an ambiguous comparison.
function currentIfMatchingWeek(storedData, currentWeek) {
  if (!storedData) return null;
  if (currentWeek == null || storedData.week == null) return storedData;
  return storedData.week === currentWeek ? storedData : null;
}

async function buildSnapshot() {
  // Each data source is fetched independently so one failing (e.g. ESPN
  // rate-limiting, a cookie expiring, a network hiccup) doesn't silently
  // degrade the WHOLE snapshot back to stale cached data. Every section
  // gets its own try/catch and surfaces its own error instead.

  let espnLeagues = [];
  let espnLeaguesError = null;
  try {
    espnLeagues = await espn.fetchAllLeagues();
  } catch (err) {
    espnLeaguesError = err.message;
  }

  // NFL scores/box-scores come from the cache, NOT a fresh fetch — see
  // cachedNflData comment above. This is what "manual refresh" means in
  // practice: /api/snapshot is cheap and pollable as before, but the NFL
  // data inside it only changes when /api/refresh-nfl-data was called.
  const { games, summaries, gameDataError } = cachedNflData;

  // ESPN's own scoringPeriodId is the ground truth for "what week is it
  // right now" — use it to detect and clear stale captures from a prior
  // week automatically, rather than showing last week's picks/roster under
  // this week's frame. Falls back gracefully if ESPN data isn't available
  // (e.g. during the caching bugs of past weeks — better to keep showing
  // old data than to wipe everything on an unrelated fetch failure).
  const currentWeek = espnLeagues.find(l => l.scoringPeriodId != null)?.scoringPeriodId ?? null;

  const pickem1Week = currentIfMatchingWeek(readJSON('pickem1Picks', null), currentWeek);
  const pickem2Week = currentIfMatchingWeek(readJSON('pickem2Picks', null), currentWeek);
  const survivorWeek = currentIfMatchingWeek(readJSON('survivorPick', null), currentWeek);
  const yahooRosterWeek = currentIfMatchingWeek(readJSON('yahooRoster', null), currentWeek);

  const gradePool = (poolWeek) => poolWeek
    ? { ...poolWeek, picks: gradePicks.gradePickemWeek(poolWeek.picks, games) }
    : null;

  const gradedPickem1 = gradePool(pickem1Week);
  const gradedPickem2 = gradePool(pickem2Week);

  const gradedSurvivor = survivorWeek
    ? { ...survivorWeek, ...gradePicks.gradeSurvivorPick(survivorWeek.pickedTeam, games) }
    : null;

  let yahooScore = null;
  if (yahooRosterWeek?.roster?.length) {
    try {
      yahooScore = await yahooScoring.computeLiveRosterScore(yahooRosterWeek.roster, summaries, currentWeek);
    } catch (err) {
      yahooScore = { total: null, players: [], note: `Error computing Yahoo score: ${err.message}` };
    }
  }

  let yahooOpponentScore = null;
  if (yahooRosterWeek?.opponentRoster?.length) {
    try {
      yahooOpponentScore = await yahooScoring.computeLiveOpponentScore(yahooRosterWeek.opponentRoster, summaries, currentWeek);
    } catch (err) {
      yahooOpponentScore = { total: null, players: [], note: `Error computing opponent score: ${err.message}` };
    }
  }

  let td = null;
  try {
    td = tdWindows.computeTdWindowsFromSummaries(games, summaries);
  } catch (err) {
    td = { windows: null, total: null, error: err.message };
  }

  return {
    fetchedAt: new Date().toISOString(),
    nflDataFetchedAt: cachedNflData.fetchedAt, // when the NFL data was last manually refreshed — lets the UI show "as of X"
    currentWeek,
    espnLeagues,
    espnLeaguesError,
    games,
    gameDataError,
    pickem1: gradedPickem1,
    pickem2: gradedPickem2,
    survivor: gradedSurvivor,
    yahoo: {
      roster: yahooRosterWeek,
      score: yahooScore,
      opponentScore: yahooOpponentScore,
    },
    td,
  };
}

app.get('/api/snapshot', async (req, res) => {
  // This endpoint must never be cached — a 304 here means the browser (or an
  // intermediate proxy) serves a stale snapshot instead of live data, which
  // silently breaks the whole "live" premise of the app.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (!tracking.isTrackingOn()) {
    return res.json(lastSnapshot || { fetchedAt: null, note: 'Tracking is off and no snapshot exists yet.' });
  }

  // buildSnapshot() no longer throws for individual data-source failures —
  // those are captured inline as *Error fields. This catch is now only for
  // a genuinely unexpected crash (e.g. a bug in grading logic), and even
  // then we surface the error rather than silently serving stale data with
  // no indication anything is wrong.
  try {
    const snapshot = await buildSnapshot();
    lastSnapshot = snapshot;
    writeJSON('lastSnapshot', snapshot);
    res.json(snapshot);
  } catch (err) {
    res.json({
      ...(lastSnapshot || {}),
      fetchedAt: lastSnapshot?.fetchedAt || null,
      snapshotBuildError: err.message,
    });
  }
});

// ---------- Weekly photo capture ----------

app.post('/api/capture/:kind', upload.single('photo'), async (req, res) => {
  const { kind } = req.params; // 'pickem1' | 'pickem2' | 'survivor' | 'yahooRoster'
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    // Pool 1 (Prevent Defense) is a confidence pool, Pool 2 (Sunday Funday)
    // is straight pick'em — each needs its own extraction prompt since
    // what to look for on the screen genuinely differs between them.
    const extracted = await vision.extractFromImage(base64, mediaType, kind);

    const storeKey = captureStoreKey(kind);
    if (!storeKey) return res.status(400).json({ error: `Unknown capture kind: ${kind}` });

    res.json({ extracted, storeKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirms (and optionally edits) an extraction before it's saved as this week's data.
app.post('/api/capture/:kind/confirm', (req, res) => {
  const { kind } = req.params;
  const storeKey = captureStoreKey(kind);
  if (!storeKey) return res.status(400).json({ error: `Unknown capture kind: ${kind}` });

  writeJSON(storeKey, req.body);
  res.json({ saved: true });
});

function captureStoreKey(kind) {
  if (kind === 'pickem1') return 'pickem1Picks';
  if (kind === 'pickem2') return 'pickem2Picks';
  if (kind === 'survivor') return 'survivorPick';
  if (kind === 'yahooRoster') return 'yahooRoster';
  return null;
}

// ---------- Yahoo scoring settings (captured once) ----------

app.get('/api/yahoo-settings', (req, res) => {
  res.json(readJSON('yahooScoringSettings', null));
});

app.post('/api/yahoo-settings', (req, res) => {
  writeJSON('yahooScoringSettings', req.body);
  res.json({ saved: true });
});

// ---------- Manual scoring overrides (kicker distance, D/ST, anything auto-scoring gets wrong) ----------
// Tagged by NFL week — an override set in one week never silently carries
// over and applies to a different week's game.

app.get('/api/yahoo-manual-adjustments', (req, res) => {
  const week = req.query.week ? parseInt(req.query.week, 10) : null;
  res.json(yahooScoring.getManualAdjustments(week));
});

app.post('/api/yahoo-manual-adjustments', (req, res) => {
  const { playerName, points, week } = req.body;
  if (!playerName) return res.status(400).json({ error: 'playerName is required.' });
  const updated = yahooScoring.setManualAdjustment(playerName, points === '' ? null : points, week ?? null);
  res.json(updated);
});

app.post('/api/yahoo-manual-adjustments/reset', (req, res) => {
  const { week } = req.body;
  const updated = yahooScoring.resetAllAdjustments(week ?? null);
  res.json(updated);
});

// ---------- API-Football usage status (for the manual-refresh countdown) ----------

app.get('/api/nfl-data-usage', (req, res) => {
  try {
    res.json(nflScores.getUsageStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually triggers a real API-Football fetch and updates the cache that
// /api/snapshot reads from on every poll. This is the ONLY path that
// spends API-Football daily-quota requests — everything else reads the
// cache. Returns the updated usage status alongside the fresh data so the
// frontend can update its countdown immediately without a second call.
app.post('/api/refresh-nfl-data', async (req, res) => {
  try {
    const { games, summaries } = await nflScores.fetchAllLiveGameSummaries();
    cachedNflData = { games, summaries, gameDataError: null, fetchedAt: new Date().toISOString() };
    writeJSON('cachedNflData', cachedNflData);
    res.json({ success: true, usage: nflScores.getUsageStatus(), fetchedAt: cachedNflData.fetchedAt });
  } catch (err) {
    // Keep the old cached data on a failed refresh — a bad refresh attempt
    // shouldn't wipe out the last successful one.
    res.status(500).json({ success: false, error: err.message, usage: nflScores.getUsageStatus() });
  }
});

// ---------- TEMPORARY: check ESPN's totalPoints field on a live matchup ----------
app.get('/api/_test-espn-totals', async (req, res) => {
  try {
    const leagueId = req.query.leagueId || '184624';
    const fetch = require('node-fetch');
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${process.env.ESPN_SEASON || '2026'}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mScoreboard&view=mLiveScoring`;
    const cookie = `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID};`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Cookie: cookie,
      },
    });
    const data = await response.json();
    // Just the matchup-level fields, not full rosters — small, focused response.
    const matchups = (data.schedule || []).map(m => ({
      id: m.id,
      matchupPeriodId: m.matchupPeriodId,
      home: m.home ? { teamId: m.home.teamId, totalPoints: m.home.totalPoints, pointsByScoringPeriod: m.home.pointsByScoringPeriod } : null,
      away: m.away ? { teamId: m.away.teamId, totalPoints: m.away.totalPoints, pointsByScoringPeriod: m.away.pointsByScoringPeriod } : null,
    }));
    res.json({ status: response.status, currentMatchupPeriod: data.status?.currentMatchupPeriod, scoringPeriodId: data.scoringPeriodId, matchups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Command Center running on port ${PORT}`);
});
