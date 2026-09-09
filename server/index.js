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

  let games = [];
  let summaries = [];
  let gameDataError = null;
  try {
    const result = await nflScores.fetchAllLiveGameSummaries();
    games = result.games;
    summaries = result.summaries;
  } catch (err) {
    gameDataError = err.message;
  }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Command Center running on port ${PORT}`);
});
