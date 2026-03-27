'use strict';

const $ = id => document.getElementById(id);

const states = {
  idle:    $('state-idle'),
  loading: $('state-loading'),
  error:   $('state-error'),
  results: $('state-results'),
};

function showState(name) {
  for (const [k, el] of Object.entries(states)) el.classList.toggle('hidden', k !== name);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runScan() {
  const tab = await getActiveTab();
  if (!tab) return showError('No active tab found.');

  $('btn-scan').disabled = true;
  showState('loading');

  chrome.runtime.sendMessage({ type: MSG.SCAN_REQUEST, tabId: tab.id }, (resp) => {
    $('btn-scan').disabled = false;
    if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
    if (!resp || resp.type === MSG.SCAN_ERROR) return showError(resp?.error || 'Scan failed.');
    renderResults(resp.results);
  });
}

function renderResults(results) {
  const formatted = formatResults(results);
  const scoring   = computeScore(results.violations);
  const counts    = countsByImpact(formatted.violations);
  const score     = typeof scoring === 'number' ? scoring : scoring.score;
  const grade     = typeof scoring === 'object' ? scoring.grade : '';
  const breakdown = typeof scoring === 'object' ? scoring.breakdown : {};

  // Score ring
  const CIRCUMFERENCE = 150.8;
  const offset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE;
  const ring = $('ring-progress');
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = scoreColor(score);
  $('score-value').textContent = Math.round(score);
  $('score-grade').textContent = grade;

  // Breakdown
  for (const imp of ['critical', 'serious', 'moderate', 'minor']) {
    $(`cnt-${imp}`).textContent = breakdown[imp] || 0;
  }

  // Stats
  $('stat-violations').textContent = formatted.violations.length;
  $('stat-passes').textContent     = formatted.passes.length;
  $('stat-incomplete').textContent = formatted.incomplete.length;

  // Meta
  $('scan-url').textContent  = results.url || '';
  $('scan-time').textContent = results.timestamp ? new Date(results.timestamp).toLocaleString() : '';

  showState('results');
}

function showError(msg) {
  $('error-msg').textContent = msg;
  showState('error');
}

// Try to load cached results on popup open
async function init() {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.runtime.sendMessage({ type: MSG.GET_CACHED_RESULTS, tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp?.cached?.results) renderResults(resp.cached.results);
  });
}

$('btn-scan').addEventListener('click', runScan);
init();
