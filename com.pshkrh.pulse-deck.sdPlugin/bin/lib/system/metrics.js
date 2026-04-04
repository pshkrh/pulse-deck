"use strict";

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const METRIC_CPU = "cpu";
const METRIC_CPU_TEMP = "cpu_temp";
const METRIC_MEMORY = "memory";
const METRIC_PING = "ping";
const METRIC_BATTERY = "battery";
const METRIC_UPTIME = "uptime";

const ALL_METRICS = [METRIC_CPU, METRIC_CPU_TEMP, METRIC_MEMORY, METRIC_PING, METRIC_BATTERY, METRIC_UPTIME];

const DEFAULT_HISTORY_SIZE = 30;
const DEFAULT_BATTERY_REFRESH_MS = 15_000;
const DEFAULT_PING_REFRESH_MS = 30_000;
const MIN_PING_REFRESH_MS = 5_000;
const MAX_PING_REFRESH_MS = 300_000;
const COMMAND_OUTPUT_MAX_BUFFER = 1024 * 1024;
const VM_STAT_TIMEOUT_MS = 700;
const PMSET_TIMEOUT_MS = 700;
const CPU_TEMP_SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "cpu_temp.swift");
const CPU_TEMP_TIMEOUT_MS = 1000;
const PING_HOST_TIMEOUT_MS = 900;
const PING_TOTAL_TIMEOUT_MS = 1400;

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function clampNonNegative(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

function execFileUtf8(command, args, timeoutMs) {
  return childProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
  });
}

function captureCpuSnapshotFromOs() {
  const cpus = os.cpus();

  let user = 0;
  let system = 0;
  let nice = 0;
  let idle = 0;

  for (const cpu of cpus) {
    const times = cpu.times || {};
    user += times.user || 0;
    system += times.sys || 0;
    nice += times.nice || 0;
    idle += times.idle || 0;
  }

  return {
    user,
    system,
    nice,
    idle,
  };
}

function parseVmStatOutput(output) {
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  const lines = output.split("\n");
  const pageSizeMatch = lines[0]?.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : NaN;
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return null;
  }

  const values = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^\"?(.+?)\"?:\s+([0-9,]+)\./);
    if (!match) {
      continue;
    }

    const rawLabel = match[1].trim().replace(/^Pages\s+/i, "");
    const key = rawLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const value = Number(match[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      continue;
    }
    values[key] = value;
  }

  return {
    pageSize,
    values,
  };
}

function computeUsedPercentFromVmStat(parsedVmStat, totalBytes) {
  if (!parsedVmStat || !parsedVmStat.values || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return null;
  }

  const values = parsedVmStat.values;
  const activePages = Number(values.active) || 0;
  const inactivePages = Number(values.inactive) || 0;
  const speculativePages = Number(values.speculative) || 0;
  const wiredPages = Number(values.wired_down) || Number(values.wire_count) || 0;
  const compressedPages = Number(values.occupied_by_compressor) || Number(values.compressor_page_count) || 0;
  const purgeablePages = Number(values.purgeable) || Number(values.purgeable_count) || 0;
  const externalPages = Number(values.file_backed_pages) || Number(values.external_page_count) || 0;

  // Match exelban/stats formula:
  // used = active + inactive + speculative + wired + compressed - purgeable - external
  const usedPages = Math.max(
    0,
    activePages +
      inactivePages +
      speculativePages +
      wiredPages +
      compressedPages -
      purgeablePages -
      externalPages
  );
  const usedBytes = usedPages * parsedVmStat.pageSize;
  if (!Number.isFinite(usedBytes) || usedBytes < 0) {
    return null;
  }

  return clampPercent((usedBytes / totalBytes) * 100);
}

function readMemoryUsageFromOs() {
  const total = os.totalmem();

  try {
    const vmStatRaw = execFileUtf8("vm_stat", [], VM_STAT_TIMEOUT_MS);

    const parsedVmStat = parseVmStatOutput(vmStatRaw);
    const vmStatPercent = computeUsedPercentFromVmStat(parsedVmStat, total);
    if (Number.isFinite(vmStatPercent)) {
      const usedBytes = (vmStatPercent / 100) * total;
      return {
        total,
        free: Math.max(0, total - usedBytes),
      };
    }
  } catch {
    // Fall back to Node's memory counters if vm_stat is unavailable.
  }

  return {
    total,
    free: os.freemem(),
  };
}

function parsePmsetBatteryPercent(output) {
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  if (/no batteries/i.test(output)) {
    return null;
  }

  const match = output.match(/(\d+)\s*%/);
  if (!match) {
    return null;
  }

  return clampPercent(Number(match[1]));
}

function readBatteryPercentFromOs() {
  try {
    const output = execFileUtf8("pmset", ["-g", "batt"], PMSET_TIMEOUT_MS);
    return parsePmsetBatteryPercent(output);
  } catch {
    return null;
  }
}

function readUptimeHoursFromOs() {
  return clampNonNegative(os.uptime() / 3600);
}

function parsePingLatencyMs(output) {
  if (typeof output !== "string" || output.trim().length === 0) {
    return null;
  }

  const summaryMatch = output.match(/round-trip\s+min\/avg\/max\/(?:stddev|mdev)\s*=\s*[0-9.]+\/([0-9.]+)\//i);
  if (summaryMatch) {
    return clampNonNegative(Number(summaryMatch[1]));
  }

  const packetMatch = output.match(/time=([0-9.]+)\s*ms/i);
  if (packetMatch) {
    return clampNonNegative(Number(packetMatch[1]));
  }

  return null;
}

function readPingLatencyMs(host, timeoutMs = PING_HOST_TIMEOUT_MS) {
  if (!host) {
    return null;
  }

  try {
    const output = execFileUtf8("ping", ["-c", "1", "-n", "-q", host], timeoutMs);
    return parsePingLatencyMs(output);
  } catch {
    return null;
  }
}

function readPingLatencyWithFallback() {
  const startedAt = Date.now();
  for (const host of ["1.1.1.1", "8.8.8.8"]) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = PING_TOTAL_TIMEOUT_MS - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }

    const timeoutMs = Math.max(250, Math.min(PING_HOST_TIMEOUT_MS, remainingMs));
    const latency = readPingLatencyMs(host, timeoutMs);
    if (Number.isFinite(latency)) {
      return latency;
    }
  }
  return null;
}

function computeCpuUsage(previous, current) {
  if (!previous || !current) {
    return 0;
  }

  const userDelta = Math.max(0, (current.user || 0) - (previous.user || 0));
  const systemDelta = Math.max(0, (current.system || 0) - (previous.system || 0));
  const niceDelta = Math.max(0, (current.nice || 0) - (previous.nice || 0));
  const idleDelta = Math.max(0, (current.idle || 0) - (previous.idle || 0));

  const totalTicks = userDelta + systemDelta + niceDelta + idleDelta;
  if (totalTicks <= 0) {
    return 0;
  }

  // Match exelban/stats CPU usage:
  // totalUsage = (systemDiff / totalTicks) + (userDiff / totalTicks)
  return clampPercent(((systemDelta + userDelta) / totalTicks) * 100);
}

function readCpuTempFromOs() {
  try {
    const output = execFileUtf8("swift", [CPU_TEMP_SCRIPT_PATH], CPU_TEMP_TIMEOUT_MS);
    const value = Number(output.trim());
    if (Number.isFinite(value) && value > 0) {
      return clampNonNegative(value);
    }
    return null;
  } catch {
    return null;
  }
}

function computeMemoryUsage(memorySnapshot) {
  const total = Number(memorySnapshot?.total) || 0;
  const free = Number(memorySnapshot?.free) || 0;

  if (total <= 0) {
    return 0;
  }

  return clampPercent(((total - free) / total) * 100);
}

function appendHistory(history, value, maxSize) {
  if (history.length > 0 && Math.abs(history[history.length - 1] - value) < 0.05) {
    return;
  }

  history.push(value);
  if (history.length > maxSize) {
    history.splice(0, history.length - maxSize);
  }
}

function normalizePingRefreshMs(value, fallbackMs = DEFAULT_PING_REFRESH_MS) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallbackMs;
  }

  const rounded = Math.round(numericValue);
  if (rounded === 0) {
    return 0;
  }
  return Math.max(MIN_PING_REFRESH_MS, Math.min(MAX_PING_REFRESH_MS, rounded));
}

function normalizeRequestedMetrics(requestedMetrics) {
  if (!Array.isArray(requestedMetrics) || requestedMetrics.length === 0) {
    return new Set(ALL_METRICS);
  }

  const metricSet = new Set();
  for (const metric of requestedMetrics) {
    if (ALL_METRICS.includes(metric)) {
      metricSet.add(metric);
    }
  }

  return metricSet.size > 0 ? metricSet : new Set(ALL_METRICS);
}

function createMetricSampler(options = {}) {
  const historySize = Number.isInteger(options.historySize) && options.historySize > 0
    ? options.historySize
    : DEFAULT_HISTORY_SIZE;

  const batteryRefreshMs = Number.isInteger(options.batteryRefreshMs) && options.batteryRefreshMs >= 0
    ? options.batteryRefreshMs
    : DEFAULT_BATTERY_REFRESH_MS;

  let pingRefreshMs = normalizePingRefreshMs(options.pingRefreshMs, DEFAULT_PING_REFRESH_MS);

  const readCpuSnapshot = options.readCpuSnapshot || captureCpuSnapshotFromOs;
  const readMemoryUsage = options.readMemoryUsage || readMemoryUsageFromOs;
  const readBatteryPercent = options.readBatteryPercent || readBatteryPercentFromOs;
  const readPingLatency = options.readPingLatency || readPingLatencyWithFallback;
  const readUptimeHours = options.readUptimeHours || readUptimeHoursFromOs;
  const now = options.now || Date.now;

  const historyByMetric = {
    [METRIC_CPU]: [],
    [METRIC_CPU_TEMP]: [],
    [METRIC_MEMORY]: [],
    [METRIC_PING]: [],
    [METRIC_BATTERY]: [],
    [METRIC_UPTIME]: [],
  };

  let previousCpuSnapshot = readCpuSnapshot();

  const pingState = {
    value: 0,
    nextRefreshAt: 0,
  };

  const batteryState = {
    value: 0,
    nextRefreshAt: 0,
  };

  let latest = {
    [METRIC_CPU]: 0,
    [METRIC_CPU_TEMP]: 0,
    [METRIC_MEMORY]: 0,
    [METRIC_PING]: 0,
    [METRIC_BATTERY]: 0,
    [METRIC_UPTIME]: 0,
  };

  function sampleCachedMetric(currentTime, state, refreshMs, reader, normalizer) {
    if (currentTime >= state.nextRefreshAt) {
      const readValue = reader();
      if (Number.isFinite(readValue)) {
        state.value = normalizer(readValue);
      }
      state.nextRefreshAt = currentTime + refreshMs;
    }

    return state.value;
  }

  return {
    sample(requestedMetrics) {
      const activeMetrics = normalizeRequestedMetrics(requestedMetrics);
      const currentTime = now();
      const currentCpuSnapshot = readCpuSnapshot();

      if (activeMetrics.has(METRIC_CPU)) {
        const cpuPercent = roundToTenths(computeCpuUsage(previousCpuSnapshot, currentCpuSnapshot));
        latest[METRIC_CPU] = cpuPercent;
        appendHistory(historyByMetric[METRIC_CPU], cpuPercent, historySize);
      }
      
      if (activeMetrics.has(METRIC_CPU_TEMP)) {
        const cpuTemp = roundToTenths(readCpuTempFromOs() || 0);
        latest[METRIC_CPU_TEMP] = cpuTemp;
        appendHistory(historyByMetric[METRIC_CPU_TEMP], cpuTemp, historySize);
      }
      
      previousCpuSnapshot = currentCpuSnapshot;

      if (activeMetrics.has(METRIC_MEMORY)) {
        const memoryPercent = roundToTenths(computeMemoryUsage(readMemoryUsage()));
        latest[METRIC_MEMORY] = memoryPercent;
        appendHistory(historyByMetric[METRIC_MEMORY], memoryPercent, historySize);
      }

      if (activeMetrics.has(METRIC_PING)) {
        const pingMs = roundToTenths(
          sampleCachedMetric(currentTime, pingState, pingRefreshMs, readPingLatency, clampNonNegative)
        );
        latest[METRIC_PING] = pingMs;
        appendHistory(historyByMetric[METRIC_PING], pingMs, historySize);
      }

      if (activeMetrics.has(METRIC_BATTERY)) {
        const batteryPercent = roundToTenths(
          sampleCachedMetric(currentTime, batteryState, batteryRefreshMs, readBatteryPercent, clampPercent)
        );
        latest[METRIC_BATTERY] = batteryPercent;
        appendHistory(historyByMetric[METRIC_BATTERY], batteryPercent, historySize);
      }

      if (activeMetrics.has(METRIC_UPTIME)) {
        const uptimeHours = roundToTenths(clampNonNegative(readUptimeHours()));
        latest[METRIC_UPTIME] = uptimeHours;
        appendHistory(historyByMetric[METRIC_UPTIME], uptimeHours, historySize);
      }

      return {
        ...latest,
        history: {
          [METRIC_CPU]: [...historyByMetric[METRIC_CPU]],
          [METRIC_CPU_TEMP]: [...historyByMetric[METRIC_CPU_TEMP]],
          [METRIC_MEMORY]: [...historyByMetric[METRIC_MEMORY]],
          [METRIC_PING]: [...historyByMetric[METRIC_PING]],
          [METRIC_BATTERY]: [...historyByMetric[METRIC_BATTERY]],
          [METRIC_UPTIME]: [...historyByMetric[METRIC_UPTIME]],
        },
      };
    },
    getLatest(metric) {
      return latest[metric] ?? 0;
    },
    getHistory(metric) {
      const history = historyByMetric[metric];
      return Array.isArray(history) ? [...history] : [];
    },
    getMetrics() {
      return [...ALL_METRICS];
    },
    setPingRefreshMs(nextPingRefreshMs) {
      pingRefreshMs = normalizePingRefreshMs(nextPingRefreshMs, pingRefreshMs);
      // Force the next sample to honor updated configuration immediately.
      pingState.nextRefreshAt = 0;
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
