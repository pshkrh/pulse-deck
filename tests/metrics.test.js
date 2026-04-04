"use strict";

const assert = require("node:assert/strict");

const {
  METRIC_CPU,
  METRIC_CPU_TEMP,
  METRIC_MEMORY,
  METRIC_PING,
  METRIC_BATTERY,
  METRIC_UPTIME,
  computeCpuUsage,
  computeMemoryUsage,
  computeUsedPercentFromVmStat,
  createMetricSampler,
  parsePingLatencyMs,
  parsePmsetBatteryPercent,
  parseVmStatOutput,
} = require("../com.pshkrh.pulse-deck.sdPlugin/bin/lib/system/metrics");

// Returns a reader that steps through an array of values, clamping at the last entry.
function makeReader(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

// ---------------------------------------------------------------------------
// computeCpuUsage / computeMemoryUsage
// ---------------------------------------------------------------------------

function testUsageComputations() {
  assert.equal(
    computeCpuUsage(
      { user: 100, system: 80, nice: 20, idle: 100 },
      { user: 130, system: 110, nice: 30, idle: 160 }
    ).toFixed(1),
    "46.2"
  );

  // Nice time increases the denominator but not the numerator (Stats-compatible).
  assert.equal(
    computeCpuUsage(
      { user: 100, system: 80, nice: 20, idle: 100 },
      { user: 110, system: 90, nice: 70, idle: 120 }
    ).toFixed(1),
    "22.2"
  );

  assert.equal(computeMemoryUsage({ total: 1000, free: 250 }), 75);
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function testParserHelpers() {
  const vmStatFixture = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                4159.",
    "Pages active:                            203546.",
    "Pages inactive:                          195700.",
    "Pages speculative:                         6723.",
    "Pages wired down:                        210763.",
    "Pages purgeable:                              8.",
    "Pages occupied by compressor:            378013.",
    "File-backed pages:                       129841.",
  ].join("\n");

  const parsedVmStat = parseVmStatOutput(vmStatFixture);
  assert.ok(parsedVmStat);
  assert.equal(parsedVmStat.pageSize, 16384);
  assert.equal(parsedVmStat.values.active, 203546);
  assert.equal(parsedVmStat.values.inactive, 195700);
  assert.equal(parsedVmStat.values.speculative, 6723);
  assert.equal(parsedVmStat.values.wired_down, 210763);
  assert.equal(parsedVmStat.values.purgeable, 8);
  assert.equal(parsedVmStat.values.occupied_by_compressor, 378013);
  assert.equal(parsedVmStat.values.file_backed_pages, 129841);
  assert.equal(computeUsedPercentFromVmStat(parsedVmStat, 17179869184).toFixed(1), "82.5");

  assert.equal(
    parsePmsetBatteryPercent(
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=35455075)\t80%; AC attached; not charging present: true"
    ),
    80
  );

  assert.equal(parsePingLatencyMs("64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=11.500 ms"), 11.5);
  assert.equal(parsePingLatencyMs("round-trip min/avg/max/stddev = 8.667/12.345/13.999/0.500 ms"), 12.345);
}

// ---------------------------------------------------------------------------
// Sampler — basic history and metric values
// ---------------------------------------------------------------------------

function testSamplerHistoryAndMetrics() {
  const sampler = createMetricSampler({
    historySize: 2,
    readCpuSnapshot:   makeReader([
      { user: 0,  system: 0,  nice: 0, idle: 0  },
      { user: 6,  system: 4,  nice: 0, idle: 10 },
      { user: 14, system: 7,  nice: 2, idle: 15 },
      { user: 20, system: 11, nice: 5, idle: 25 },
    ]),
    readCpuTemp:       makeReader([40, 41, 42]),
    readMemoryUsage:   makeReader([{ total: 1000, free: 500 }, { total: 1000, free: 450 }, { total: 1000, free: 200 }]),
    readPingLatency:   makeReader([12.5, 10.2, 8.4]),
    readBatteryPercent:makeReader([80, 81, 82]),
    readUptimeHours:   makeReader([36.0, 36.2, 36.4]),
    pingRefreshMs:  0,
    batteryRefreshMs: 0,
    now: makeReader([0, 1000, 2000]),
  });

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_CPU),      50);
  assert.equal(sampler.getLatest(METRIC_CPU_TEMP), 40);
  assert.equal(sampler.getLatest(METRIC_MEMORY),   50);
  assert.equal(sampler.getLatest(METRIC_PING),     12.5);
  assert.equal(sampler.getLatest(METRIC_BATTERY),  80);
  assert.equal(sampler.getLatest(METRIC_UPTIME),   36);

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_CPU),      61.1);
  assert.equal(sampler.getLatest(METRIC_CPU_TEMP), 41);
  assert.equal(sampler.getLatest(METRIC_MEMORY),   55);
  assert.equal(sampler.getLatest(METRIC_PING),     10.2);
  assert.equal(sampler.getLatest(METRIC_BATTERY),  81);
  assert.equal(sampler.getLatest(METRIC_UPTIME),   36.2);

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_CPU),      43.5);
  assert.equal(sampler.getLatest(METRIC_CPU_TEMP), 42);
  assert.equal(sampler.getLatest(METRIC_MEMORY),   80);
  assert.equal(sampler.getLatest(METRIC_PING),     8.4);
  assert.equal(sampler.getLatest(METRIC_BATTERY),  82);
  assert.equal(sampler.getLatest(METRIC_UPTIME),   36.4);

  // History is capped at historySize=2
  assert.deepEqual(sampler.getHistory(METRIC_CPU),      [61.1, 43.5]);
  assert.deepEqual(sampler.getHistory(METRIC_CPU_TEMP), [41, 42]);
  assert.deepEqual(sampler.getHistory(METRIC_MEMORY),   [55, 80]);
  assert.deepEqual(sampler.getHistory(METRIC_PING),     [10.2, 8.4]);
  assert.deepEqual(sampler.getHistory(METRIC_BATTERY),  [81, 82]);
  assert.deepEqual(sampler.getHistory(METRIC_UPTIME),   [36.2, 36.4]);

  assert.deepEqual(sampler.getMetrics(), [
    METRIC_CPU, METRIC_CPU_TEMP, METRIC_MEMORY, METRIC_PING, METRIC_BATTERY, METRIC_UPTIME,
  ]);
}

// ---------------------------------------------------------------------------
// Sampler — ping refresh configuration
// ---------------------------------------------------------------------------

function testPingRefreshConfiguration() {
  const sampler = createMetricSampler({
    historySize: 5,
    readCpuSnapshot:   makeReader([
      { user: 0, system: 0, nice: 0, idle: 0 },
      { user: 1, system: 1, nice: 0, idle: 2 },
      { user: 2, system: 2, nice: 0, idle: 4 },
      { user: 3, system: 3, nice: 0, idle: 6 },
    ]),
    readCpuTemp:       () => 40,
    readMemoryUsage:   makeReader([{ total: 1000, free: 500 }]),
    readPingLatency:   makeReader([20, 40, 60]),
    readBatteryPercent:makeReader([70]),
    readUptimeHours:   makeReader([1]),
    pingRefreshMs:    30_000,
    batteryRefreshMs: 0,
    now: makeReader([0, 1000, 2000, 7000]),
  });

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_PING), 20);

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_PING), 20); // cached, not yet refreshed

  sampler.setPingRefreshMs(5_000);
  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_PING), 40); // forced refresh

  sampler.sample();
  assert.equal(sampler.getLatest(METRIC_PING), 60);
}

// ---------------------------------------------------------------------------
// Sampler — selective metric sampling
// ---------------------------------------------------------------------------

function testSelectiveMetricSampling() {
  let memoryReads = 0, pingReads = 0, batteryReads = 0, uptimeReads = 0;

  const sampler = createMetricSampler({
    historySize: 4,
    readCpuSnapshot:   makeReader([
      { user: 0,  system: 0, nice: 0, idle: 0  },
      { user: 10, system: 5, nice: 0, idle: 15 },
      { user: 20, system: 10, nice: 0, idle: 30 },
    ]),
    readCpuTemp:       () => 40,
    readMemoryUsage:   () => { memoryReads++;  return { total: 1000, free: 250 }; },
    readPingLatency:   () => { pingReads++;    return 10; },
    readBatteryPercent:() => { batteryReads++; return 80; },
    readUptimeHours:   () => { uptimeReads++;  return 2; },
    pingRefreshMs:  0,
    batteryRefreshMs: 0,
    now: makeReader([0, 1000]),
  });

  sampler.sample([METRIC_CPU]);
  assert.equal(memoryReads,  0);
  assert.equal(pingReads,    0);
  assert.equal(batteryReads, 0);
  assert.equal(uptimeReads,  0);

  sampler.sample([METRIC_MEMORY, METRIC_UPTIME]);
  assert.equal(memoryReads,  1);
  assert.equal(pingReads,    0);
  assert.equal(batteryReads, 0);
  assert.equal(uptimeReads,  1);
}

// ---------------------------------------------------------------------------
// Sampler — history deduplication
// ---------------------------------------------------------------------------

function testHistoryDeduplication() {
  const sampler = createMetricSampler({
    historySize: 10,
    readCpuSnapshot:   makeReader([
      { user: 0, system: 0, nice: 0, idle: 0 },
      { user: 1, system: 1, nice: 0, idle: 2 },
      { user: 2, system: 2, nice: 0, idle: 4 },
      { user: 3, system: 3, nice: 0, idle: 6 },
    ]),
    readCpuTemp:       () => 40,
    readMemoryUsage:   makeReader([{ total: 1000, free: 500 }]),
    readPingLatency:   () => 15,
    readBatteryPercent:() => 80,
    readUptimeHours:   () => 12,
    pingRefreshMs:  0,
    batteryRefreshMs: 0,
    now: makeReader([0, 1000, 2000]),
  });

  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);
  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);
  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);

  // Constant values should only appear once in history.
  assert.deepEqual(sampler.getHistory(METRIC_PING),    [15]);
  assert.deepEqual(sampler.getHistory(METRIC_BATTERY), [80]);
  assert.deepEqual(sampler.getHistory(METRIC_UPTIME),  [12]);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run() {
  testUsageComputations();
  testParserHelpers();
  testSamplerHistoryAndMetrics();
  testPingRefreshConfiguration();
  testSelectiveMetricSampling();
  testHistoryDeduplication();
  console.log("metrics tests passed");
}

run();
