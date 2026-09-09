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

async function buildSnapshot() {
  const [espnLeagues, { games, summaries }] = await Promise.all([
    espn.fetchAllLeagues(),
    nflScores.fetchAllLiveGameSummaries(),
  ]);

  const pickem1Week = readJSON('pickem1Picks', null);
  const pickem2Week = readJSON('pickem2Picks', null);
  const survivorWeek = readJSON('survivorPick', null);
  const yahooRosterWeek = readJSON('yahooRoster', null);

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
      yahooScore = await yahooScoring.computeLiveRosterScore(yahooRosterWeek.roster, summaries);
    } catch (err) {
      yahooScore = { total: null, players: [], note: `Error computing Yahoo score: ${err.message}` };
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
    espnLeagues,
    games,
    pickem1: gradedPickem1,
    pickem2: gradedPickem2,
    survivor: gradedSurvivor,
    yahoo: {
      roster: yahooRosterWeek,
      score: yahooScore,
    },
    td,
  };
}

app.get('/api/snapshot', async (req, res) => {
  if (!tracking.isTrackingOn()) {
    return res.json(lastSnapshot || { fetchedAt: null, note: 'Tracking is off and no snapshot exists yet.' });
  }

  try {
    const snapshot = await buildSnapshot();
    lastSnapshot = snapshot;
    writeJSON('lastSnapshot', snapshot);
    res.json(snapshot);
  } catch (err) {
    // If a live fetch fails, fall back to last known snapshot rather than erroring the UI.
    res.json(lastSnapshot || { fetchedAt: null, error: err.message });
  }
});

// ---------- Weekly photo capture ----------

app.post('/api/capture/:kind', upload.single('photo'), async (req, res) => {
  const { kind } = req.params; // 'pickem1' | 'pickem2' | 'survivor' | 'yahooRoster'
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    // Both pick'em pools use the same extraction prompt — 'pickem1'/'pickem2'
    // are just which pool's picks get stored where; the photo itself looks identical.
    const visionKind = (kind === 'pickem1' || kind === 'pickem2') ? 'pickem' : kind;
    const extracted = await vision.extractFromImage(base64, mediaType, visionKind);

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

app.get('/api/yahoo-manual-adjustments', (req, res) => {
  res.json(yahooScoring.getManualAdjustments());
});

app.post('/api/yahoo-manual-adjustments', (req, res) => {
  const { playerName, points } = req.body;
  if (!playerName) return res.status(400).json({ error: 'playerName is required.' });
  const updated = yahooScoring.setManualAdjustment(playerName, points === '' ? null : points);
  res.json(updated);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Command Center running on port ${PORT}`);
});
