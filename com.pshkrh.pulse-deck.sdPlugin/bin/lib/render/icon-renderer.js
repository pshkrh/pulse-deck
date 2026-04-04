"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const TRANSPARENT_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sJd7s8AAAAASUVORK5CYII=";
const DEFAULT_RENDER_TIMEOUT_MS = 1500;
const COMMAND_OUTPUT_MAX_BUFFER = 512 * 1024;

const PERCENT_METRICS = new Set(["cpu", "memory", "battery"]);
const NON_PERCENT_METRICS = new Set(["ping", "uptime"]);
const TEMP_METRICS = new Set(["cpu_temp"]);
const KNOWN_METRICS = new Set([...PERCENT_METRICS, ...NON_PERCENT_METRICS, ...TEMP_METRICS]);

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function hashInput(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function toDataUrl(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return `data:image/png;base64,${fileBuffer.toString("base64")}`;
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
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((value) => Number.isFinite(value))
    .map((value) => normalizeValue(metric, value));
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // no-op
  }
}

function pruneCache(cacheMap, filePathByKey, maxEntries) {
  while (cacheMap.size > maxEntries) {
    const oldestKey = cacheMap.keys().next().value;
    if (!oldestKey) {
      break;
    }

    cacheMap.delete(oldestKey);
    removeFileIfExists(filePathByKey.get(oldestKey));
    filePathByKey.delete(oldestKey);
  }
}

function formatRendererError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr.length > 0) {
    return stderr.split("\n")[0];
  }

  if (typeof error?.status === "number") {
    return `renderer exited with code ${error.status}`;
  }

  if (typeof error?.signal === "string" && error.signal.length > 0) {
    return `renderer terminated by signal ${error.signal}`;
  }

  if (typeof error?.message === "string" && error.message.length > 0) {
    return error.message.split("\n")[0];
  }

  return "renderer execution failed";
}

function createVitalRenderer(options = {}) {
  const cacheDirectory = options.cacheDirectory;
  const rendererScriptPath = options.rendererScriptPath;
  const maxMemoryCacheEntries = Number.isInteger(options.maxMemoryCacheEntries) && options.maxMemoryCacheEntries > 0
    ? options.maxMemoryCacheEntries
    : 300;
  const renderTimeoutMs = Number.isInteger(options.renderTimeoutMs) && options.renderTimeoutMs > 0
    ? options.renderTimeoutMs
    : DEFAULT_RENDER_TIMEOUT_MS;

  if (!cacheDirectory) {
    throw new Error("cacheDirectory is required");
  }

  if (!rendererScriptPath) {
    throw new Error("rendererScriptPath is required");
  }

  ensureDirectory(cacheDirectory);

  const imageCache = new Map();
  const filePathByKey = new Map();

  return {
    transparentImage: TRANSPARENT_PNG_DATA_URL,
    renderTile(metric, value, history) {
      const safeMetric = normalizeMetric(metric);
      const safeValue = normalizeValue(safeMetric, value);
      const safeHistory = normalizeHistory(safeMetric, history);
      const historyPayload = safeHistory.join(",");
      const cacheKey = hashInput(`${safeMetric}|${safeValue.toFixed(1)}|${historyPayload}`);

      if (imageCache.has(cacheKey)) {
        return imageCache.get(cacheKey);
      }

      const outputPath = path.join(cacheDirectory, `${cacheKey}.png`);

      if (!fs.existsSync(outputPath)) {
        try {
          childProcess.execFileSync(
            "python3",
            [rendererScriptPath, safeMetric, safeValue.toFixed(1), historyPayload, outputPath],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: renderTimeoutMs,
              maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
            }
          );
        } catch (error) {
          removeFileIfExists(outputPath);
          throw new Error(formatRendererError(error));
        }
      }

      let dataUrl = TRANSPARENT_PNG_DATA_URL;
      try {
        dataUrl = toDataUrl(outputPath);
      } catch {
        dataUrl = TRANSPARENT_PNG_DATA_URL;
      }

      imageCache.set(cacheKey, dataUrl);
      filePathByKey.set(cacheKey, outputPath);
      pruneCache(imageCache, filePathByKey, maxMemoryCacheEntries);
      return dataUrl;
    },
  };
}

module.exports = {
  TRANSPARENT_PNG_DATA_URL,
  createVitalRenderer,
};
