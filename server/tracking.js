// Tracking on/off toggle.
// When ON, the frontend polls live data on its normal interval.
// When OFF, the frontend freezes on the last snapshot it has (no more requests),
// and the backend also stops its own upstream polling to avoid burning API calls.

const { readJSON, writeJSON } = require('./store');

let state = readJSON('tracking', { on: false, lastChangedAt: null });

function isTrackingOn() {
  return !!state.on;
}

function setTracking(on) {
  state = { on: !!on, lastChangedAt: new Date().toISOString() };
  writeJSON('tracking', state);
  return state;
}

function getState() {
  return state;
}

module.exports = { isTrackingOn, setTracking, getState };
