"use strict";

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const METRIC_CPU      = "cpu";
const METRIC_CPU_TEMP = "cpu_temp";
const METRIC_MEMORY   = "memory";
const METRIC_PING     = "ping";
const METRIC_BATTERY  = "battery";
const METRIC_UPTIME   = "uptime";

const ALL_METRICS     = [METRIC_CPU, METRIC_CPU_TEMP, METRIC_MEMORY, METRIC_PING, METRIC_BATTERY, METRIC_UPTIME];
const ALL_METRICS_SET = new Set(ALL_METRICS);

const DEFAULT_HISTORY_SIZE       = 30;
const DEFAULT_BATTERY_REFRESH_MS = 15_000;
const DEFAULT_PING_REFRESH_MS    = 30_000;
const MIN_PING_REFRESH_MS        = 5_000;
const MAX_PING_REFRESH_MS        = 300_000;
const COMMAND_OUTPUT_MAX_BUFFER  = 1024 * 1024;
const VM_STAT_TIMEOUT_MS         = 700;
const PMSET_TIMEOUT_MS           = 700;
const CPU_TEMP_SCRIPT_PATH       = path.join(__dirname, "..", "..", "scripts", "cpu_temp.swift");
const CPU_TEMP_TIMEOUT_MS        = 1000;
const PING_HOST_TIMEOUT_MS       = 900;
const PING_TOTAL_TIMEOUT_MS      = 1400;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function clampNonNegative(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function execFileUtf8(command, args, timeoutMs) {
  return childProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
  });
}

// ---------------------------------------------------------------------------
// CPU usage
// ---------------------------------------------------------------------------

function captureCpuSnapshotFromOs() {
  let user = 0, system = 0, nice = 0, idle = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times || {};
    user   += t.user || 0;
    system += t.sys  || 0;
    nice   += t.nice || 0;
    idle   += t.idle || 0;
  }
  return { user, system, nice, idle };
}

function computeCpuUsage(previous, current) {
  if (!previous || !current) return 0;

  const userDelta   = Math.max(0, (current.user   || 0) - (previous.user   || 0));
  const systemDelta = Math.max(0, (current.system || 0) - (previous.system || 0));
  const niceDelta   = Math.max(0, (current.nice   || 0) - (previous.nice   || 0));
  const idleDelta   = Math.max(0, (current.idle   || 0) - (previous.idle   || 0));

  const totalTicks = userDelta + systemDelta + niceDelta + idleDelta;
  if (totalTicks <= 0) return 0;

  // Match exelban/stats: totalUsage = (system + user) / total
  return clampPercent(((systemDelta + userDelta) / totalTicks) * 100);
}

// ---------------------------------------------------------------------------
// CPU temperature (Apple Silicon via IOHIDEventSystem — see cpu_temp.swift)
// ---------------------------------------------------------------------------

function readCpuTempFromOs() {
  try {
    const output = execFileUtf8("swift", [CPU_TEMP_SCRIPT_PATH], CPU_TEMP_TIMEOUT_MS);
    const value = Number(output.trim());
    return Number.isFinite(value) && value > 0 ? clampNonNegative(value) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory usage (vm_stat for accuracy, os.freemem as fallback)
// ---------------------------------------------------------------------------

function parseVmStatOutput(output) {
  if (typeof output !== "string" || output.trim().length === 0) return null;

  const lines = output.split("\n");
  const pageSizeMatch = lines[0]?.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : NaN;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const values = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^"?(.+?)"?:\s+([0-9,]+)\./);
    if (!match) continue;
    const key = match[1].trim()
      .replace(/^Pages\s+/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const value = Number(match[2].replace(/,/g, ""));
    if (Number.isFinite(value)) values[key] = value;
  }

  return { pageSize, values };
}

function computeUsedPercentFromVmStat(parsedVmStat, totalBytes) {
  if (!parsedVmStat?.values || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;

  const v = parsedVmStat.values;
  // Match exelban/stats: used = active + inactive + speculative + wired + compressed - purgeable - external
  const usedPages = Math.max(0,
    (Number(v.active) || 0) +
    (Number(v.inactive) || 0) +
    (Number(v.speculative) || 0) +
    (Number(v.wired_down) || Number(v.wire_count) || 0) +
    (Number(v.occupied_by_compressor) || Number(v.compressor_page_count) || 0) -
    (Number(v.purgeable) || Number(v.purgeable_count) || 0) -
    (Number(v.file_backed_pages) || Number(v.external_page_count) || 0)
  );

  const usedBytes = usedPages * parsedVmStat.pageSize;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return null;
  return clampPercent((usedBytes / totalBytes) * 100);
}

function readMemoryUsageFromOs() {
  const total = os.totalmem();
  try {
    const parsedVmStat = parseVmStatOutput(execFileUtf8("vm_stat", [], VM_STAT_TIMEOUT_MS));
    const vmStatPercent = computeUsedPercentFromVmStat(parsedVmStat, total);
    if (Number.isFinite(vmStatPercent)) {
      return { total, free: Math.max(0, total - (vmStatPercent / 100) * total) };
    }
  } catch {
    // Fall back to Node's memory counters if vm_stat is unavailable.
  }
  return { total, free: os.freemem() };
}

function computeMemoryUsage(memorySnapshot) {
  const total = Number(memorySnapshot?.total) || 0;
  const free  = Number(memorySnapshot?.free)  || 0;
  if (total <= 0) return 0;
  return clampPercent(((total - free) / total) * 100);
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

function parsePmsetBatteryPercent(output) {
  if (typeof output !== "string" || output.trim().length === 0) return null;
  if (/no batteries/i.test(output)) return null;
  const match = output.match(/(\d+)\s*%/);
  return match ? clampPercent(Number(match[1])) : null;
}

function readBatteryPercentFromOs() {
  try {
    return parsePmsetBatteryPercent(execFileUtf8("pmset", ["-g", "batt"], PMSET_TIMEOUT_MS));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Uptime
// ---------------------------------------------------------------------------

function readUptimeHoursFromOs() {
  return clampNonNegative(os.uptime() / 3600);
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

function parsePingLatencyMs(output) {
  if (typeof output !== "string" || output.trim().length === 0) return null;

  const summaryMatch = output.match(/round-trip\s+min\/avg\/max\/(?:stddev|mdev)\s*=\s*[0-9.]+\/([0-9.]+)\//i);
  if (summaryMatch) return clampNonNegative(Number(summaryMatch[1]));

  const packetMatch = output.match(/time=([0-9.]+)\s*ms/i);
  if (packetMatch) return clampNonNegative(Number(packetMatch[1]));

  return null;
}

function readPingLatencyMs(host, timeoutMs = PING_HOST_TIMEOUT_MS) {
  if (!host) return null;
  try {
    return parsePingLatencyMs(execFileUtf8("ping", ["-c", "1", "-n", "-q", host], timeoutMs));
  } catch {
    return null;
  }
}

function readPingLatencyWithFallback() {
  const startedAt = Date.now();
  for (const host of ["1.1.1.1", "8.8.8.8"]) {
    const remainingMs = PING_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const latency = readPingLatencyMs(host, Math.max(250, Math.min(PING_HOST_TIMEOUT_MS, remainingMs)));
    if (Number.isFinite(latency)) return latency;
  }
  return null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function appendHistory(history, value, maxSize) {
  // Skip if the new value is the same as the last (to tenths precision).
  if (history.length > 0 && Math.round(history[history.length - 1] * 10) === Math.round(value * 10)) {
    return;
  }
  history.push(value);
  // We only ever push one at a time so we can only ever overshoot by one.
  if (history.length > maxSize) history.shift();
}

// ---------------------------------------------------------------------------
// Ping refresh normalization
// ---------------------------------------------------------------------------

function normalizePingRefreshMs(value, fallbackMs = DEFAULT_PING_REFRESH_MS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackMs;
  const rounded = Math.round(n);
  if (rounded === 0) return 0;
  return Math.max(MIN_PING_REFRESH_MS, Math.min(MAX_PING_REFRESH_MS, rounded));
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

function normalizeRequestedMetrics(requestedMetrics) {
  if (!Array.isArray(requestedMetrics) || requestedMetrics.length === 0) {
    return ALL_METRICS_SET;
  }
  const metricSet = new Set();
  for (const metric of requestedMetrics) {
    if (ALL_METRICS_SET.has(metric)) metricSet.add(metric);
  }
  return metricSet.size > 0 ? metricSet : ALL_METRICS_SET;
}

function createMetricSampler(options = {}) {
  const historySize = Number.isInteger(options.historySize) && options.historySize > 0
    ? options.historySize
    : DEFAULT_HISTORY_SIZE;

  const batteryRefreshMs = Number.isInteger(options.batteryRefreshMs) && options.batteryRefreshMs >= 0
    ? options.batteryRefreshMs
    : DEFAULT_BATTERY_REFRESH_MS;

  let pingRefreshMs = normalizePingRefreshMs(options.pingRefreshMs, DEFAULT_PING_REFRESH_MS);

  const readCpuSnapshot  = options.readCpuSnapshot  || captureCpuSnapshotFromOs;
  const readCpuTemp      = options.readCpuTemp       || readCpuTempFromOs;
  const readMemoryUsage  = options.readMemoryUsage   || readMemoryUsageFromOs;
  const readBatteryPercent = options.readBatteryPercent || readBatteryPercentFromOs;
  const readPingLatency  = options.readPingLatency   || readPingLatencyWithFallback;
  const readUptimeHours  = options.readUptimeHours   || readUptimeHoursFromOs;
  const now              = options.now               || Date.now;

  const historyByMetric = {
    [METRIC_CPU]:      [],
    [METRIC_CPU_TEMP]: [],
    [METRIC_MEMORY]:   [],
    [METRIC_PING]:     [],
    [METRIC_BATTERY]:  [],
    [METRIC_UPTIME]:   [],
  };

  const latest = {
    [METRIC_CPU]:      0,
    [METRIC_CPU_TEMP]: 0,
    [METRIC_MEMORY]:   0,
    [METRIC_PING]:     0,
    [METRIC_BATTERY]:  0,
    [METRIC_UPTIME]:   0,
  };

  const pingState    = { value: 0, nextRefreshAt: 0 };
  const batteryState = { value: 0, nextRefreshAt: 0 };

  let previousCpuSnapshot = readCpuSnapshot();

  function sampleCachedMetric(currentTime, state, refreshMs, reader, normalizer) {
    if (currentTime >= state.nextRefreshAt) {
      const readValue = reader();
      if (Number.isFinite(readValue)) state.value = normalizer(readValue);
      state.nextRefreshAt = currentTime + refreshMs;
    }
    return state.value;
  }

  return {
    sample(requestedMetrics) {
      const activeMetrics = normalizeRequestedMetrics(requestedMetrics);
      const currentTime = now();

      // Always capture a CPU snapshot to keep the delta accurate even if CPU
      // metric is not currently active (so the first render after toggling is correct).
      const currentCpuSnapshot = readCpuSnapshot();

      if (activeMetrics.has(METRIC_CPU)) {
        const v = roundToTenths(computeCpuUsage(previousCpuSnapshot, currentCpuSnapshot));
        latest[METRIC_CPU] = v;
        appendHistory(historyByMetric[METRIC_CPU], v, historySize);
      }

      if (activeMetrics.has(METRIC_CPU_TEMP)) {
        const v = roundToTenths(readCpuTemp() || 0);
        latest[METRIC_CPU_TEMP] = v;
        appendHistory(historyByMetric[METRIC_CPU_TEMP], v, historySize);
      }

      previousCpuSnapshot = currentCpuSnapshot;

      if (activeMetrics.has(METRIC_MEMORY)) {
        const v = roundToTenths(computeMemoryUsage(readMemoryUsage()));
        latest[METRIC_MEMORY] = v;
        appendHistory(historyByMetric[METRIC_MEMORY], v, historySize);
      }

      if (activeMetrics.has(METRIC_PING)) {
        const v = roundToTenths(sampleCachedMetric(currentTime, pingState, pingRefreshMs, readPingLatency, clampNonNegative));
        latest[METRIC_PING] = v;
        appendHistory(historyByMetric[METRIC_PING], v, historySize);
      }

      if (activeMetrics.has(METRIC_BATTERY)) {
        const v = roundToTenths(sampleCachedMetric(currentTime, batteryState, batteryRefreshMs, readBatteryPercent, clampPercent));
        latest[METRIC_BATTERY] = v;
        appendHistory(historyByMetric[METRIC_BATTERY], v, historySize);
      }

      if (activeMetrics.has(METRIC_UPTIME)) {
        const v = roundToTenths(clampNonNegative(readUptimeHours()));
        latest[METRIC_UPTIME] = v;
        appendHistory(historyByMetric[METRIC_UPTIME], v, historySize);
      }
    },

    getLatest(metric) {
      return latest[metric] ?? 0;
    },

    getHistory(metric) {
      const h = historyByMetric[metric];
      return Array.isArray(h) ? h.slice(0) : [];
    },

    getMetrics() {
      return [...ALL_METRICS];
    },

    setPingRefreshMs(nextPingRefreshMs) {
      pingRefreshMs = normalizePingRefreshMs(nextPingRefreshMs, pingRefreshMs);
      pingState.nextRefreshAt = 0; // Apply immediately on next sample.
    },
  };
}

module.exports = {
  METRIC_CPU,
  METRIC_CPU_TEMP,
  METRIC_MEMORY,
  METRIC_PING,
  METRIC_BATTERY,
  METRIC_UPTIME,
  ALL_METRICS,
  DEFAULT_HISTORY_SIZE,
  DEFAULT_PING_REFRESH_MS,
  MIN_PING_REFRESH_MS,
  MAX_PING_REFRESH_MS,
  clampPercent,
  computeCpuUsage,
  computeMemoryUsage,
  computeUsedPercentFromVmStat,
  createMetricSampler,
  normalizePingRefreshMs,
  parsePingLatencyMs,
  parsePmsetBatteryPercent,
  parseVmStatOutput,
};
