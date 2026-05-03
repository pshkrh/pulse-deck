#!/usr/bin/env node
"use strict";

const { createStreamDeckClient } = require("./lib/runtime/streamdeck-client");
const {
  METRIC_CPU,
  METRIC_CPU_TEMP,
  METRIC_MEMORY,
  METRIC_PING,
  METRIC_BATTERY,
  METRIC_UPTIME,
  DEFAULT_PING_REFRESH_MS,
  MIN_PING_REFRESH_MS,
  MAX_PING_REFRESH_MS,
  createMetricSampler,
} = require("./lib/system/metrics");
const { createVitalRenderer } = require("./lib/render/icon-renderer");

const ACTION_CPU       = "com.pshkrh.pulse-deck.cpu";
const ACTION_CPU_TEMP  = "com.pshkrh.pulse-deck.cpu_temp";
const ACTION_MEMORY    = "com.pshkrh.pulse-deck.memory";
const ACTION_PING      = "com.pshkrh.pulse-deck.ping";
const ACTION_BATTERY   = "com.pshkrh.pulse-deck.battery";
const ACTION_UPTIME    = "com.pshkrh.pulse-deck.uptime";

const ACTION_TO_METRIC = new Map([
   [ACTION_CPU,      METRIC_CPU],
   [ACTION_CPU_TEMP, METRIC_CPU_TEMP],
   [ACTION_MEMORY,   METRIC_MEMORY],
   [ACTION_PING,     METRIC_PING],
   [ACTION_BATTERY,  METRIC_BATTERY],
   [ACTION_UPTIME,   METRIC_UPTIME],
]);

const CPU_TOGGLE_PAIR = new Map([
   [METRIC_CPU,      METRIC_CPU_TEMP],
   [METRIC_CPU_TEMP, METRIC_CPU],
]);

const POLL_INTERVAL_MS       = 1000;
const HISTORY_SIZE           = 32;
const PING_INTERVAL_SETTINGS_KEY = "pingIntervalSeconds";
const DEFAULT_PING_INTERVAL_SECONDS = Math.round(DEFAULT_PING_REFRESH_MS / 1000);
const MIN_PING_INTERVAL_SECONDS          = Math.ceil(MIN_PING_REFRESH_MS / 1000);
const MAX_PING_INTERVAL_SECONDS          = Math.floor(MAX_PING_REFRESH_MS / 1000);

const client = createStreamDeckClient({ pluginLabel: "Pulse Deck" });
const sampler = createMetricSampler({
  historySize: HISTORY_SIZE,
  pingRefreshMs: DEFAULT_PING_REFRESH_MS,
});
const renderer = createVitalRenderer({});

// context -> current metric
const contexts = new Map();
// metric -> Set of contexts showing that metric
const contextsByMetric = new Map([
   [METRIC_CPU,      new Set()],
   [METRIC_CPU_TEMP, new Set()],
   [METRIC_MEMORY,   new Set()],
   [METRIC_PING,     new Set()],
   [METRIC_BATTERY,  new Set()],
   [METRIC_UPTIME,   new Set()],
]);
// context -> last rendered data URL (skip re-send if unchanged)
const lastImageByContext = new Map();
// context -> whether the CPU button is currently showing temp (true) or usage (false)
const cpuTempActive = new Map();

let pollTimer = null;
let refreshInProgress = false;
let refreshPending = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePingIntervalSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PING_INTERVAL_SECONDS;
  return Math.max(MIN_PING_INTERVAL_SECONDS, Math.min(MAX_PING_INTERVAL_SECONDS, Math.round(n)));
}

function applyPingSettings(settings) {
  const seconds = normalizePingIntervalSeconds(settings?.[PING_INTERVAL_SETTINGS_KEY]);
  sampler.setPingRefreshMs(seconds * 1000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMetric(metric) {
  const metricContexts = contextsByMetric.get(metric);
  if (!metricContexts || metricContexts.size === 0) return;

  const value = sampler.getLatest(metric);
  const history = sampler.getHistory(metric);
  let imageDataUrl;
  try {
    imageDataUrl = renderer.renderTile(metric, value, history);
    } catch (error) {
    client.logMessage("Failed to render " + metric + " tile: " + error.message);
    return;
   }

  if (!imageDataUrl) return;

  for (const context of metricContexts) {
    if (lastImageByContext.get(context) === imageDataUrl) continue;
    client.setImage(context, imageDataUrl);
    lastImageByContext.set(context, imageDataUrl);
   }
}

function getActiveMetrics() {
  const active = [];
  for (const [metric, ctxs] of contextsByMetric) {
    if (ctxs.size > 0) active.push(metric);
   }
  return active;
}

function runRefreshCycle() {
  const activeMetrics = getActiveMetrics();
  if (activeMetrics.length === 0) return;

  try {
    sampler.sample(activeMetrics);
    } catch (error) {
    client.logMessage("Failed to sample system metrics: " + error.message);
    return;
   }

  for (const metric of activeMetrics) {
    renderMetric(metric);
   }
}

function refreshAndRenderAll() {
  if (refreshInProgress) {
    refreshPending = true;
    return;
   }

  refreshInProgress = true;
  try {
    runRefreshCycle();
    } finally {
    refreshInProgress = false;
   }

  if (refreshPending) {
    refreshPending = false;
    refreshAndRenderAll();
   }
}

// ---------------------------------------------------------------------------
// Polling lifecycle
// ---------------------------------------------------------------------------

function startPollingIfNeeded() {
  if (pollTimer || contexts.size === 0) return;
  refreshAndRenderAll();
  pollTimer = setInterval(refreshAndRenderAll, POLL_INTERVAL_MS);
}

function stopPollingIfIdle() {
  if (contexts.size > 0 || !pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleWillAppear(event) {
  const metric = ACTION_TO_METRIC.get(event.action);
  if (!metric) return;

  contexts.set(event.context, metric);
  contextsByMetric.get(metric).add(event.context);

  if (metric === METRIC_PING) {
    applyPingSettings(event.payload?.settings);
    } else if (metric === METRIC_CPU) {
    cpuTempActive.set(event.context, false);
   }

  client.setTitle(event.context, "");

   // Prime the metric on first appearance so there's something to render immediately.
  if (sampler.getHistory(metric).length === 0) {
    try {
      sampler.sample([metric]);
      } catch (error) {
      client.logMessage("Failed to prime " + metric + " metric: " + error.message);
     }
   }

  startPollingIfNeeded();
  renderMetric(metric);
}

function handleWillDisappear(event) {
  const metric = contexts.get(event.context);
  if (!metric) return;

  contextsByMetric.get(metric).delete(event.context);
  contexts.delete(event.context);
  lastImageByContext.delete(event.context);
  cpuTempActive.delete(event.context);
  stopPollingIfIdle();
}

function handleKeyDown(event) {
  const currentMetric = contexts.get(event.context);
  if (!currentMetric) return;

   // CPU button toggles between usage and temperature on each press.
  const toggleTarget = CPU_TOGGLE_PAIR.get(currentMetric);
  if (toggleTarget !== undefined) {
    contextsByMetric.get(currentMetric).delete(event.context);
    contextsByMetric.get(toggleTarget).add(event.context);
    contexts.set(event.context, toggleTarget);
    cpuTempActive.set(event.context, toggleTarget === METRIC_CPU_TEMP);
    refreshAndRenderAll();
    return;
   }

  refreshAndRenderAll();
}

function handleDidReceiveSettings(event) {
  if (event.action !== ACTION_PING) return;
  applyPingSettings(event.payload?.settings);
  refreshAndRenderAll();
}

function onStreamDeckEvent(event) {
  switch (event.event) {
    case "willAppear":        handleWillAppear(event);         break;
    case "willDisappear":     handleWillDisappear(event);      break;
    case "keyDown":           handleKeyDown(event);            break;
    case "didReceiveSettings":handleDidReceiveSettings(event); break;
    default: break;
   }
}

client.onEvent(onStreamDeckEvent);

try {
  client.connect();
  } catch (error) {
   // eslint-disable-next-line no-console
  console.error("[Pulse Deck] " + error.message);
  process.exit(1);
}
