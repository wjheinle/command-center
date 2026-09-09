const POLL_INTERVAL_MS = 20000; // 20s — within the 15-30s target

let pollTimer = null;
let trackingOn = false;
let lastRenderedFantasyBoxes = []; // kept so the expand overlay can re-render the same data larger
let activePickemPool = 1; // 1 or 2 — which pool's picks are shown/captured
let lastSnapshotData = null; // kept so switching pools re-renders without a refetch

// ---------- Clock ----------

function tickClock() {
  const el = document.getElementById('clock');
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 1000);
tickClock();

// ---------- Tracking toggle ----------

const trackingBtn = document.getElementById('trackingBtn');

async function fetchTrackingState() {
  const res = await fetch('/api/tracking', { cache: 'no-store' });
  const state = await res.json();
  applyTrackingState(state.on);
}

function applyTrackingState(on) {
  trackingOn = on;
  trackingBtn.dataset.on = String(on);
  trackingBtn.querySelector('.label').textContent = on ? 'Tracking On' : 'Tracking Off';
  if (on) startPolling(); else stopPolling();
}

trackingBtn.addEventListener('click', async () => {
  const next = !trackingOn;
  const res = await fetch('/api/tracking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: next }),
  });
  const state = await res.json();
  applyTrackingState(state.on);
  if (next) fetchSnapshot();
});

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------- Snapshot fetch + render ----------

async function fetchSnapshot() {
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    const snapshot = await res.json();
    renderSnapshot(snapshot);
  } catch (err) {
    console.error('Snapshot fetch failed', err);
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;
  lastSnapshotData = snapshot;
  renderFantasyGrid(snapshot.espnLeagues || [], snapshot.yahoo, snapshot.espnLeaguesError);
  renderPickem(activePickemPool === 1 ? snapshot.pickem1 : snapshot.pickem2);
  renderSurvivor(snapshot.survivor);
  renderTdTracker(snapshot.td);
}

// ---------- Unified fantasy box model ----------
// Every one of the 4 boxes (3 ESPN + 1 Yahoo) is normalized into the same
// shape so one render function and one expand/collapse behavior covers all
// four: { id, title, tag, totals: {home, away}, players: [...] }

function normalizeEspnLeague(league) {
  const m = (league.matchups || [])[0];
  return {
    id: `espn-${league.leagueId}`,
    title: league.leagueName || 'League',
    tag: league.myTeamFound === false ? 'name not matched' : null,
    error: league.error || null,
    totals: m ? {
      home: { label: m.home?.teamName, total: m.home?.score },
      away: m.away ? { label: m.away.teamName, total: m.away.score } : null,
    } : null,
    // ESPN roster-level player scoring isn't pulled in the current matchup
    // view (would need the mRoster player breakdown per team) — shown as a
    // simple matchup box for now, players list intentionally empty.
    players: [],
  };
}

function normalizeYahoo(yahoo) {
  const roster = yahoo?.roster?.roster || [];
  const score = yahoo?.score;
  const myTotal = score?.total;

  // Fall back to showing captured projections before kickoff, when the live
  // scoring engine has nothing yet — better than every player reading "—"
  // all Sunday morning.
  const players = score?.players?.length
    ? score.players.map(p => {
        if (p.points != null) return p;
        const captured = roster.find(r => r.playerName === p.playerName);
        return captured?.projection != null
          ? { ...p, points: captured.projection, note: (p.note ? p.note + ' ' : '') + '(showing projection — game not live yet)' }
          : p;
      })
    : roster.map(r => ({ playerName: r.playerName, position: r.position, points: r.projection ?? null, note: r.projection != null ? '(projection)' : null }));

  return {
    id: 'yahoo',
    title: 'Red Hawk (Yahoo)', // full team name is too long for the box header — shown in full in the totals row instead
    tag: 'estimate',
    captureKind: 'yahooRoster',
    error: null,
    totals: {
      home: { label: 'Who Drank All the Bitch Pops', total: myTotal },
      away: yahoo?.roster?.opponentTeamName ? { label: yahoo.roster.opponentTeamName, total: null } : null,
    },
    players,
  };
}

function renderFantasyGrid(espnLeagues, yahoo, espnLeaguesError) {
  let boxes;

  if (espnLeaguesError) {
    // A real fetch error occurred — show one visible error box instead of
    // silently rendering nothing, so this is never invisible again.
    boxes = [
      { id: 'espn-error', title: 'ESPN Leagues', tag: null, error: espnLeaguesError, totals: null, players: [] },
      normalizeYahoo(yahoo),
    ];
  } else if (!espnLeagues.length) {
    // No error thrown, but also no leagues came back — most likely
    // ESPN_LEAGUE_IDS is empty/misconfigured. Show a placeholder rather
    // than just leaving three grid cells blank with no explanation.
    boxes = [
      { id: 'espn-empty', title: 'ESPN Leagues', tag: null, error: 'No leagues configured or returned — check ESPN_LEAGUE_IDS.', totals: null, players: [] },
      normalizeYahoo(yahoo),
    ];
  } else {
    boxes = [
      ...espnLeagues.map(normalizeEspnLeague),
      normalizeYahoo(yahoo),
    ];
  }

  lastRenderedFantasyBoxes = boxes;

  const container = document.getElementById('fantasyGrid');
  container.innerHTML = '';
  boxes.forEach(box => {
    container.appendChild(renderFantasyBox(box, false));
  });

  // If the expand overlay is currently open on one of these boxes, refresh it too.
  if (expandedBoxId) {
    const box = boxes.find(b => b.id === expandedBoxId);
    if (box) showExpanded(box);
  }
}

function renderFantasyBox(box, expanded) {
  const el = document.createElement('div');
  el.className = 'fantasy-box';
  el.dataset.boxId = box.id;

  const head = document.createElement('div');
  head.className = 'fantasy-box-head';
  head.innerHTML = `
    <h2>${escapeHtml(box.title)}</h2>
    <span class="fantasy-box-head-right">
      ${box.tag ? `<span class="fantasy-box-tag">${escapeHtml(box.tag)}</span>` : ''}
      ${box.captureKind ? `<button class="capture-btn box-capture-btn" data-kind="${escapeHtml(box.captureKind)}">Capture</button>` : ''}
    </span>
  `;
  el.appendChild(head);

  if (box.error) {
    const body = document.createElement('div');
    body.className = 'fantasy-box-players';
    body.innerHTML = `<p class="empty-state">Couldn't load: ${escapeHtml(box.error)}</p>`;
    el.appendChild(body);
  } else {
    if (box.totals) {
      const homeTotal = box.totals.home?.total;
      const awayTotal = box.totals.away?.total;
      const homeLeading = homeTotal != null && awayTotal != null && homeTotal > awayTotal;
      const awayLeading = homeTotal != null && awayTotal != null && awayTotal > homeTotal;

      const totalsRow = document.createElement('div');
      totalsRow.className = 'fantasy-box-total';
      totalsRow.innerHTML = `
        <div class="side ${homeLeading ? 'leading' : awayLeading ? 'trailing' : ''}">
          <span class="team-label">${escapeHtml(box.totals.home?.label || '')}</span>
          <span class="team-total">${formatScore(homeTotal)}</span>
        </div>
        ${box.totals.away ? `
        <span class="vs">vs</span>
        <div class="side opponent ${awayLeading ? 'leading' : homeLeading ? 'trailing' : ''}">
          <span class="team-label">${escapeHtml(box.totals.away.label || '')}</span>
          <span class="team-total">${formatScore(box.totals.away.total)}</span>
        </div>` : ''}
      `;
      el.appendChild(totalsRow);
    }

    const playersBody = document.createElement('div');
    playersBody.className = 'fantasy-box-players';
    if (!box.players || !box.players.length) {
      playersBody.innerHTML = `<p class="empty-state">No player detail yet.</p>`;
    } else {
      box.players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'player-row';
        const needsAdjust = p.position === 'K' || p.position === 'DEF' || p.position === 'D/ST' || p.note;
        row.innerHTML = `
          <span class="player-name">${escapeHtml(p.playerName)} <span class="player-pos">${escapeHtml(p.position || '')}</span></span>
          <span style="display:flex; align-items:center;">
            <span class="player-pts">${p.points != null ? p.points : '—'}</span>
            ${needsAdjust ? `<button class="adjust-btn" data-player="${escapeHtml(p.playerName)}" data-current="${p.points != null ? p.points : ''}">adjust</button>` : ''}
          </span>
        `;
        playersBody.appendChild(row);
      });
    }
    el.appendChild(playersBody);
  }

  el.addEventListener('click', (e) => {
    // Don't trigger expand/collapse when tapping the adjust or capture buttons.
    if (e.target.classList.contains('adjust-btn')) {
      e.stopPropagation();
      openAdjustPrompt(e.target.dataset.player, e.target.dataset.current);
      return;
    }
    if (e.target.classList.contains('box-capture-btn')) {
      e.stopPropagation();
      openCaptureModal(e.target.dataset.kind);
      return;
    }
    toggleExpand(box.id);
  });

  return el;
}

// ---------- Expand / collapse ----------

let expandedBoxId = null;
const expandOverlay = document.getElementById('expandOverlay');

function toggleExpand(boxId) {
  if (expandedBoxId === boxId) {
    closeExpanded();
  } else {
    const box = lastRenderedFantasyBoxes.find(b => b.id === boxId);
    if (box) showExpanded(box);
  }
}

function showExpanded(box) {
  expandedBoxId = box.id;
  expandOverlay.innerHTML = '';
  expandOverlay.appendChild(renderFantasyBox(box, true));
  expandOverlay.classList.add('open');
}

function closeExpanded() {
  expandedBoxId = null;
  expandOverlay.classList.remove('open');
  expandOverlay.innerHTML = '';
}

expandOverlay.addEventListener('click', (e) => {
  // Clicking the backdrop (not the box itself) also closes it.
  if (e.target === expandOverlay) closeExpanded();
});

// ---------- Pick'em (4x4 grid) ----------

function renderPickem(pickem) {
  const body = document.getElementById('pickemBody');
  if (!pickem || !pickem.picks || !pickem.picks.length) {
    body.innerHTML = `<p class="empty-state">No picks captured for this week yet.</p>`;
    return;
  }

  body.innerHTML = '';
  // Always render 16 cells so the grid stays a fixed 4x4 even with fewer picks captured.
  const picks = pickem.picks.slice(0, 16);
  picks.forEach(p => {
    const cell = document.createElement('div');
    cell.className = `pick-cell status-${p.status || 'pending'}`;
    cell.innerHTML = `
      <span class="pick-team">${escapeHtml(p.pickedTeam || '')}</span>
      ${p.confidence != null ? `<span class="pick-confidence">${escapeHtml(String(p.confidence))}</span>` : '<span class="pick-status-dot"></span>'}
    `;
    body.appendChild(cell);
  });
  // Pad remaining cells if fewer than 16 picks are captured yet, so the grid shape holds.
  for (let i = picks.length; i < 16; i++) {
    const cell = document.createElement('div');
    cell.className = 'pick-cell status-pending';
    cell.innerHTML = `<span class="pick-team" style="color:var(--text-dim)">—</span>`;
    body.appendChild(cell);
  }
}

// ---------- Pick'em pool toggle ----------

const poolToggleBtns = document.querySelectorAll('.pool-toggle-btn');
const pickemCaptureBtn = document.getElementById('pickemCaptureBtn');

poolToggleBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pool = parseInt(btn.dataset.pool, 10);
    if (pool === activePickemPool) return;

    activePickemPool = pool;
    poolToggleBtns.forEach(b => b.classList.toggle('active', parseInt(b.dataset.pool, 10) === pool));
    pickemCaptureBtn.dataset.kind = `pickem${pool}`;

    if (lastSnapshotData) {
      renderPickem(pool === 1 ? lastSnapshotData.pickem1 : lastSnapshotData.pickem2);
    }
  });
});

// ---------- Survivor ----------

function renderSurvivor(survivor) {
  const body = document.getElementById('survivorBody');
  if (!survivor || !survivor.pickedTeam) {
    body.innerHTML = `<p class="empty-state">No pick captured for this week yet.</p>`;
    return;
  }

  body.innerHTML = `
    <div class="survivor-row status-${survivor.status || 'pending'}">
      <span class="pick-team">${escapeHtml(survivor.pickedTeam)}</span>
      <span class="pick-status">${(survivor.status || 'pending')}</span>
    </div>
  `;
}

// ---------- TD Tracker ----------

function renderTdTracker(td) {
  const morningEl = document.getElementById('tdMorning');
  const afternoonEl = document.getElementById('tdAfternoon');
  const nightEl = document.getElementById('tdNight');
  const totalTag = document.getElementById('tdTotalTag');

  if (!td || !td.windows) {
    morningEl.textContent = '0';
    afternoonEl.textContent = '0';
    nightEl.textContent = '0';
    totalTag.textContent = '0 total';
    return;
  }

  morningEl.textContent = td.windows.morning?.count ?? 0;
  afternoonEl.textContent = td.windows.afternoon?.count ?? 0;
  nightEl.textContent = td.windows.night?.count ?? 0;
  totalTag.textContent = `${td.total ?? 0} total`;
}

// ---------- Manual override ----------

async function openAdjustPrompt(playerName, currentValue) {
  const input = window.prompt(`Manual point override for ${playerName}\n(leave blank to clear override)`, currentValue || '');
  if (input === null) return;

  const points = input.trim() === '' ? null : parseFloat(input.trim());
  if (input.trim() !== '' && Number.isNaN(points)) {
    alert('Enter a number, or leave blank to clear the override.');
    return;
  }

  await fetch('/api/yahoo-manual-adjustments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, points }),
  });
  fetchSnapshot();
}

// ---------- Helpers ----------

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatScore(n) {
  return n == null ? '—' : n;
}

// ---------- Capture modal ----------

const captureModal = document.getElementById('captureModal');
const captureModalTitle = document.getElementById('captureModalTitle');
const capturePhotoInput = document.getElementById('capturePhotoInput');
const captureStatus = document.getElementById('captureStatus');
const captureReview = document.getElementById('captureReview');
const captureConfirmBtn = document.getElementById('captureConfirmBtn');

let currentCaptureKind = null;
let currentExtraction = null;

document.querySelectorAll('.capture-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCaptureModal(btn.dataset.kind);
  });
});

function openCaptureModal(kind) {
  currentCaptureKind = kind;
  currentExtraction = null;
  captureModalTitle.textContent = `Capture — ${labelForKind(kind)}`;
  captureStatus.textContent = '';
  captureReview.innerHTML = '';
  capturePhotoInput.value = '';
  captureConfirmBtn.disabled = true;
  captureModal.classList.add('open');
}

function labelForKind(kind) {
  if (kind === 'pickem1') return "Pick'em — Prevent Defense";
  if (kind === 'pickem2') return "Pick'em — Sunday Funday";
  if (kind === 'survivor') return 'Survivor';
  if (kind === 'yahooRoster') return 'Yahoo Roster';
  return kind;
}

document.getElementById('captureModalClose').addEventListener('click', () => {
  captureModal.classList.remove('open');
});

capturePhotoInput.addEventListener('change', async () => {
  const file = capturePhotoInput.files[0];
  if (!file || !currentCaptureKind) return;

  captureStatus.textContent = 'Reading photo…';
  captureReview.innerHTML = '';
  captureConfirmBtn.disabled = true;

  const formData = new FormData();
  formData.append('photo', file);

  try {
    const res = await fetch(`/api/capture/${currentCaptureKind}`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) {
      captureStatus.textContent = `Error: ${data.error}`;
      return;
    }
    currentExtraction = data.extracted;
    captureStatus.textContent = 'Extracted — review before saving:';
    captureReview.innerHTML = `<pre>${escapeHtml(JSON.stringify(data.extracted, null, 2))}</pre>`;
    captureConfirmBtn.disabled = false;
  } catch (err) {
    captureStatus.textContent = `Error: ${err.message}`;
  }
});

captureConfirmBtn.addEventListener('click', async () => {
  if (!currentExtraction || !currentCaptureKind) return;
  captureConfirmBtn.disabled = true;
  captureStatus.textContent = 'Saving…';

  try {
    await fetch(`/api/capture/${currentCaptureKind}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentExtraction),
    });
    captureStatus.textContent = 'Saved.';
    setTimeout(() => {
      captureModal.classList.remove('open');
      fetchSnapshot();
    }, 600);
  } catch (err) {
    captureStatus.textContent = `Error saving: ${err.message}`;
    captureConfirmBtn.disabled = false;
  }
});

// ---------- Init ----------

fetchTrackingState();
fetchSnapshot();
