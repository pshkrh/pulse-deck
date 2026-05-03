"use strict";

const crypto = require("node:crypto");

const TRANSPARENT_PNG_DATA_URL =
   "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sJd7s8AAAAASUVORK5CYII=";

const PERCENT_METRICS = new Set(["cpu", "memory", "battery"]);
const NON_PERCENT_METRICS = new Set(["ping", "uptime"]);
const TEMP_METRICS = new Set(["cpu_temp"]);
const KNOWN_METRICS = new Set([...PERCENT_METRICS, ...NON_PERCENT_METRICS, ...TEMP_METRICS]);

function ensureDirectory(directoryPath) {
  try {
    require("node:fs").mkdirSync(directoryPath, { recursive: true });
   } catch {
     // directory may already exist
   }
}

function hashInput(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

function normalizeMetric(metric) {
  if (!metric || typeof metric !== "string") {
    return "cpu";
   }
  return KNOWN_METRICS.has(metric) ? metric : "cpu";
}

function normalizeValue(metric, value) {
  const numericValue = Number.isFinite(value) ? value : 0;

  if (PERCENT_METRICS.has(metric)) {
    return Math.max(0, Math.min(100, roundToTenths(numericValue)));
   }

  if (TEMP_METRICS.has(metric)) {
    return Math.max(0, Math.min(120, roundToTenths(numericValue)));
   }

  if (NON_PERCENT_METRICS.has(metric)) {
    return Math.max(0, roundToTenths(numericValue));
   }

  return Math.max(0, roundToTenths(numericValue));
}

function normalizeHistory(metric, history) {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
   }

  const normalized = [];
  for (let i = 0; i < history.length; i++) {
    const value = history[i];
    if (Number.isFinite(value)) {
      normalized.push(normalizeValue(metric, value));
     }
   }
  return normalized;
}

function createVitalRenderer(options = {}) {
  const maxMemoryCacheEntries = Number.isInteger(options.maxMemoryCacheEntries) && options.maxMemoryCacheEntries > 0
      ? options.maxMemoryCacheEntries
      : 300;

  const memoryCache = new Map();
  const maxEntries = maxMemoryCacheEntries;

  // Load canvas renderer once
  const { render } = require("./canvas-renderer");

  return {
    transparentImage: TRANSPARENT_PNG_DATA_URL,
    _memoryCache: memoryCache,
    renderTile(metric, value, history) {
      const safeMetric = normalizeMetric(metric);
      const safeValue = normalizeValue(safeMetric, value);
      const safeHistory = normalizeHistory(safeMetric, history);
      const historyPayload = safeHistory.join(",");
      const cacheKey = hashInput(safeMetric + "|" + safeValue.toFixed(1) + "|" + historyPayload);

       // Check in-memory cache first
      if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey);
       }

       // Render to in-memory PNG buffer
      let pngBuffer;
      try {
        pngBuffer = render(safeMetric, safeValue, safeHistory);
       } catch (error) {
        throw new Error("canvas render failed: " + error.message);
       }

       // Convert raw PNG to base64 data URL
      const base64 = pngBuffer.toString("base64");
      const dataUrl = "data:image/png;base64," + base64;

       // Cache in memory (LRU)
      memoryCache.set(cacheKey, dataUrl);
      if (memoryCache.size > maxEntries) {
        const oldestKey = memoryCache.keys().next().value;
        if (oldestKey) {
          memoryCache.delete(oldestKey);
         }
       }
      return dataUrl;
     },
   };
}

module.exports = {
  TRANSPARENT_PNG_DATA_URL,
  createVitalRenderer,
};
