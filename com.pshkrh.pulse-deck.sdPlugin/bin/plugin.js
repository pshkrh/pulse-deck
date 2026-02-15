#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { createStreamDeckClient } = require("./lib/runtime/streamdeck-client");
const {
  METRIC_CPU,
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

const ACTION_CPU = "com.pshkrh.pulse-deck.cpu";
const ACTION_MEMORY = "com.pshkrh.pulse-deck.memory";
const ACTION_PING = "com.pshkrh.pulse-deck.ping";
const ACTION_BATTERY = "com.pshkrh.pulse-deck.battery";
const ACTION_UPTIME = "com.pshkrh.pulse-deck.uptime";
const ACTION_TO_METRIC = new Map([
  [ACTION_CPU, METRIC_CPU],
  [ACTION_MEMORY, METRIC_MEMORY],
  [ACTION_PING, METRIC_PING],
  [ACTION_BATTERY, METRIC_BATTERY],
  [ACTION_UPTIME, METRIC_UPTIME],
]);

const POLL_INTERVAL_MS = 1000;
const HISTORY_SIZE = 32;
const PING_INTERVAL_SETTINGS_KEY = "pingIntervalSeconds";
const DEFAULT_PING_INTERVAL_SECONDS = Math.round(DEFAULT_PING_REFRESH_MS / 1000);
const MIN_PING_INTERVAL_SECONDS = Math.ceil(MIN_PING_REFRESH_MS / 1000);
const MAX_PING_INTERVAL_SECONDS = Math.floor(MAX_PING_REFRESH_MS / 1000);
const RENDER_CACHE_DIRECTORY = path.join(__dirname, "..", "imgs", "runtime-cache");
const RENDERER_SCRIPT_PATH = path.join(__dirname, "scripts", "render_vital_tile.py");

const client = createStreamDeckClient({ pluginLabel: "Pulse Deck" });
const sampler = createMetricSampler({
  historySize: HISTORY_SIZE,
  pingRefreshMs: DEFAULT_PING_REFRESH_MS,
});
const renderer = createVitalRenderer({
  cacheDirectory: RENDER_CACHE_DIRECTORY,
  rendererScriptPath: RENDERER_SCRIPT_PATH,
});

const contexts = new Map();
const contextsByMetric = new Map([
  [METRIC_CPU, new Set()],
  [METRIC_MEMORY, new Set()],
  [METRIC_PING, new Set()],
  [METRIC_BATTERY, new Set()],
  [METRIC_UPTIME, new Set()],
]);
let pollTimer = null;

function normalizePingIntervalSeconds(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_PING_INTERVAL_SECONDS;
  }

  const roundedSeconds = Math.round(numericValue);
  return Math.max(MIN_PING_INTERVAL_SECONDS, Math.min(MAX_PING_INTERVAL_SECONDS, roundedSeconds));
}

function getPingIntervalFromSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_PING_INTERVAL_SECONDS;
  }
  return normalizePingIntervalSeconds(settings[PING_INTERVAL_SETTINGS_KEY]);
}

function applyPingSettings(settings) {
  const pingIntervalSeconds = getPingIntervalFromSettings(settings);
  sampler.setPingRefreshMs(pingIntervalSeconds * 1000);
}

function resolveMetricFromAction(actionUuid) {
  return ACTION_TO_METRIC.get(actionUuid) || null;
}

function renderMetric(metric) {
  const metricContexts = contextsByMetric.get(metric);
  if (!metricContexts || metricContexts.size === 0) {
    return;
  }

  const value = sampler.getLatest(metric);
  const history = sampler.getHistory(metric);

  let imageDataUrl = renderer.transparentImage;
  try {
    imageDataUrl = renderer.renderTile(metric, value, history);
  } catch (error) {
    client.logMessage(`Failed to render ${metric} tile: ${error.message}`);
  }

  for (const context of metricContexts) {
    client.setImage(context, imageDataUrl);
    client.setTitle(context, "");
  }
}

function refreshAndRenderAll() {
  try {
    sampler.sample();
  } catch (error) {
    client.logMessage(`Failed to sample system metrics: ${error.message}`);
    return;
  }

  for (const metric of sampler.getMetrics()) {
    renderMetric(metric);
  }
}

function startPollingIfNeeded() {
  if (pollTimer || contexts.size === 0) {
    return;
  }

  refreshAndRenderAll();
  pollTimer = setInterval(refreshAndRenderAll, POLL_INTERVAL_MS);
}

function stopPollingIfIdle() {
  if (contexts.size > 0 || !pollTimer) {
    return;
  }

  clearInterval(pollTimer);
  pollTimer = null;
}

function handleWillAppear(event) {
  const metric = resolveMetricFromAction(event.action);
  if (!metric) {
    return;
  }

  contexts.set(event.context, metric);
  contextsByMetric.get(metric)?.add(event.context);
  if (metric === METRIC_PING) {
    applyPingSettings(event.payload?.settings);
  }

  client.setTitle(event.context, "");
  startPollingIfNeeded();
  renderMetric(metric);
}

function handleWillDisappear(event) {
  const metric = contexts.get(event.context);
  if (!metric) {
    return;
  }

  contextsByMetric.get(metric)?.delete(event.context);
  contexts.delete(event.context);
  stopPollingIfIdle();
}

function handleKeyDown(event) {
  if (!contexts.has(event.context)) {
    return;
  }

  refreshAndRenderAll();
}

function handleDidReceiveSettings(event) {
  if (event.action !== ACTION_PING) {
    return;
  }

  applyPingSettings(event.payload?.settings);
  refreshAndRenderAll();
}

function onStreamDeckEvent(event) {
  switch (event.event) {
    case "willAppear":
      handleWillAppear(event);
      break;
    case "willDisappear":
      handleWillDisappear(event);
      break;
    case "keyDown":
      handleKeyDown(event);
      break;
    case "didReceiveSettings":
      handleDidReceiveSettings(event);
      break;
    default:
      break;
  }
}

client.onEvent(onStreamDeckEvent);

try {
  client.connect();
} catch (error) {
  // Last resort for startup failures outside of host logging.
  // eslint-disable-next-line no-console
  console.error(`[Pulse Deck] ${error.message}`);
  process.exit(1);
}
