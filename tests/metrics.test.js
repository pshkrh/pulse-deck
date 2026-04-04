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

function createIteratorReader(values) {
  let index = 0;
  return () => {
    const selected = values[Math.min(index, values.length - 1)];
    index += 1;
    return selected;
  };
}

function testUsageComputations() {
  const cpuUsage = computeCpuUsage(
    { user: 100, system: 80, nice: 20, idle: 100 },
    { user: 130, system: 110, nice: 30, idle: 160 }
  );
  assert.equal(cpuUsage.toFixed(1), "46.2");

  const cpuUsageWithNice = computeCpuUsage(
    { user: 100, system: 80, nice: 20, idle: 100 },
    { user: 110, system: 90, nice: 70, idle: 120 }
  );
  // Nice time increases denominator but not numerator (Stats-compatible behavior).
  assert.equal(cpuUsageWithNice.toFixed(1), "22.2");

  const memoryUsage = computeMemoryUsage({ total: 1000, free: 250 });
  assert.equal(memoryUsage, 75);
}

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

  const usedPercent = computeUsedPercentFromVmStat(parsedVmStat, 17179869184);
  assert.equal(usedPercent.toFixed(1), "82.5");

  const pmsetFixture = [
    "Now drawing from 'AC Power'",
    " -InternalBattery-0 (id=35455075)\t80%; AC attached; not charging present: true",
  ].join("\n");
  assert.equal(parsePmsetBatteryPercent(pmsetFixture), 80);

  const pingPacketFixture = "64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=11.500 ms";
  assert.equal(parsePingLatencyMs(pingPacketFixture), 11.5);

  const pingSummaryFixture = "round-trip min/avg/max/stddev = 8.667/12.345/13.999/0.500 ms";
  assert.equal(parsePingLatencyMs(pingSummaryFixture), 12.345);
}

function testSamplerHistoryAndMetrics() {
  const readCpuSnapshot = createIteratorReader([
    { user: 0, system: 0, nice: 0, idle: 0 },
    { user: 6, system: 4, nice: 0, idle: 10 },
    { user: 14, system: 7, nice: 2, idle: 15 },
    { user: 20, system: 11, nice: 5, idle: 25 },
  ]);

  const readMemoryUsage = createIteratorReader([
    { total: 1000, free: 500 },
    { total: 1000, free: 450 },
    { total: 1000, free: 200 },
  ]);

  const readPingLatency = createIteratorReader([12.5, 10.2, 8.4]);
  const readBatteryPercent = createIteratorReader([80, 81, 82]);
  const readUptimeHours = createIteratorReader([36.0, 36.2, 36.4]);
  const now = createIteratorReader([0, 1000, 2000]);

  const sampler = createMetricSampler({
    historySize: 2,
    readCpuSnapshot,
    readMemoryUsage,
    readPingLatency,
    readBatteryPercent,
    readUptimeHours,
    pingRefreshMs: 0,
    batteryRefreshMs: 0,
    now,
  });

  const first = sampler.sample();
  assert.equal(first.cpu, 50);
  assert.equal(first.memory, 50);
  assert.equal(first.ping, 12.5);
  assert.equal(first.battery, 80);
  assert.equal(first.uptime, 36);

  const second = sampler.sample();
  assert.equal(second.cpu, 61.1);
  assert.equal(second.memory, 55);
  assert.equal(second.ping, 10.2);
  assert.equal(second.battery, 81);
  assert.equal(second.uptime, 36.2);

  const third = sampler.sample();
  assert.equal(third.cpu, 43.5);
  assert.equal(third.memory, 80);
  assert.equal(third.ping, 8.4);
  assert.equal(third.battery, 82);
  assert.equal(third.uptime, 36.4);

  assert.deepEqual(sampler.getHistory(METRIC_CPU), [61.1, 43.5]);
  assert.deepEqual(sampler.getHistory(METRIC_MEMORY), [55, 80]);
  assert.deepEqual(sampler.getHistory(METRIC_PING), [10.2, 8.4]);
  assert.deepEqual(sampler.getHistory(METRIC_BATTERY), [81, 82]);
  assert.deepEqual(sampler.getHistory(METRIC_UPTIME), [36.2, 36.4]);

  assert.deepEqual(sampler.getMetrics(), [
    METRIC_CPU,
    METRIC_CPU_TEMP,
    METRIC_MEMORY,
    METRIC_PING,
    METRIC_BATTERY,
    METRIC_UPTIME,
  ]);
}

function testPingRefreshConfiguration() {
  const readCpuSnapshot = createIteratorReader([
    { user: 0, system: 0, nice: 0, idle: 0 },
    { user: 1, system: 1, nice: 0, idle: 2 },
    { user: 2, system: 2, nice: 0, idle: 4 },
    { user: 3, system: 3, nice: 0, idle: 6 },
  ]);

  const readMemoryUsage = createIteratorReader([{ total: 1000, free: 500 }]);
  const readPingLatency = createIteratorReader([20, 40, 60]);
  const readBatteryPercent = createIteratorReader([70]);
  const readUptimeHours = createIteratorReader([1]);
  const now = createIteratorReader([0, 1000, 2000, 7000]);

  const sampler = createMetricSampler({
    historySize: 5,
    readCpuSnapshot,
    readMemoryUsage,
    readPingLatency,
    readBatteryPercent,
    readUptimeHours,
    pingRefreshMs: 30_000,
    batteryRefreshMs: 0,
    now,
  });

  const first = sampler.sample();
  assert.equal(first.ping, 20);

  const second = sampler.sample();
  assert.equal(second.ping, 20);

  sampler.setPingRefreshMs(5_000);
  const third = sampler.sample();
  assert.equal(third.ping, 40);

  const fourth = sampler.sample();
  assert.equal(fourth.ping, 60);
}

function testSelectiveMetricSampling() {
  let memoryReads = 0;
  let pingReads = 0;
  let batteryReads = 0;
  let uptimeReads = 0;

  const readCpuSnapshot = createIteratorReader([
    { user: 0, system: 0, nice: 0, idle: 0 },
    { user: 10, system: 5, nice: 0, idle: 15 },
    { user: 20, system: 10, nice: 0, idle: 30 },
  ]);
  const readMemoryUsage = () => {
    memoryReads += 1;
    return { total: 1000, free: 250 };
  };
  const readPingLatency = () => {
    pingReads += 1;
    return 10;
  };
  const readBatteryPercent = () => {
    batteryReads += 1;
    return 80;
  };
  const readUptimeHours = () => {
    uptimeReads += 1;
    return 2;
  };
  const now = createIteratorReader([0, 1000]);

  const sampler = createMetricSampler({
    historySize: 4,
    readCpuSnapshot,
    readMemoryUsage,
    readPingLatency,
    readBatteryPercent,
    readUptimeHours,
    pingRefreshMs: 0,
    batteryRefreshMs: 0,
    now,
  });

  sampler.sample([METRIC_CPU]);
  assert.equal(memoryReads, 0);
  assert.equal(pingReads, 0);
  assert.equal(batteryReads, 0);
  assert.equal(uptimeReads, 0);

  sampler.sample([METRIC_MEMORY, METRIC_UPTIME]);
  assert.equal(memoryReads, 1);
  assert.equal(pingReads, 0);
  assert.equal(batteryReads, 0);
  assert.equal(uptimeReads, 1);
}

function testHistoryDeduplication() {
  const readCpuSnapshot = createIteratorReader([
    { user: 0, system: 0, nice: 0, idle: 0 },
    { user: 1, system: 1, nice: 0, idle: 2 },
    { user: 2, system: 2, nice: 0, idle: 4 },
    { user: 3, system: 3, nice: 0, idle: 6 },
  ]);
  const readMemoryUsage = createIteratorReader([{ total: 1000, free: 500 }]);
  const readPingLatency = () => 15;
  const readBatteryPercent = () => 80;
  const readUptimeHours = () => 12;
  const now = createIteratorReader([0, 1000, 2000]);

  const sampler = createMetricSampler({
    historySize: 10,
    readCpuSnapshot,
    readMemoryUsage,
    readPingLatency,
    readBatteryPercent,
    readUptimeHours,
    pingRefreshMs: 0,
    batteryRefreshMs: 0,
    now,
  });

  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);
  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);
  sampler.sample([METRIC_PING, METRIC_BATTERY, METRIC_UPTIME]);

  assert.deepEqual(sampler.getHistory(METRIC_PING), [15]);
  assert.deepEqual(sampler.getHistory(METRIC_BATTERY), [80]);
  assert.deepEqual(sampler.getHistory(METRIC_UPTIME), [12]);
}

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
