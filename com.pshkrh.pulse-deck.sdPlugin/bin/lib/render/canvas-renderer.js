"use strict";

const { createCanvas, registerFont } = require("canvas");
const { existsSync } = require("node:fs");

const KEY_SIZE = 144;
const PADDING  = 12;
const HEADER_LEFT = 0;
const HEADER_TOP = 0;
const HEADER_WIDTH = KEY_SIZE;
const HEADER_HEIGHT = 26;
const HEADER_TEXT_Y = 4;
const GRAPH_LEFT   = 12;
const GRAPH_RIGHT  = KEY_SIZE - 12;
const GRAPH_TOP    = 96;
const GRAPH_BOTTOM = KEY_SIZE - 24;

const THEMES = {
  cpu: {
    label: "CPU",
    accent: [255, 102, 87],
    accent_soft: [255, 165, 120],
    mode: "percent",
  },
  cpu_temp: {
    label: "CPU",
    accent: [255, 102, 87],
    accent_soft: [255, 165, 120],
    mode: "temp",
  },
  memory: {
    label: "RAM",
    accent: [92, 177, 255],
    accent_soft: [134, 209, 255],
    mode: "percent",
  },
  ping: {
    label: "PING",
    accent: [76, 206, 222],
    accent_soft: [108, 168, 245],
    mode: "latency",
  },
  battery: {
    label: "BATTERY",
    accent: [96, 224, 122],
    accent_soft: [145, 245, 169],
    mode: "percent",
  },
  uptime: {
    label: "UPTIME",
    accent: [173, 190, 210],
    accent_soft: [132, 156, 184],
    mode: "uptime",
  },
};

// ---------------------------------------------------------------------------
// Font registration
// ---------------------------------------------------------------------------

/**
 * Font families to use in Canvas 2D API after fonts are registered.
 * These names must match the `family` passed to registerFont.
 */
const FONT_FAMILY = {
  bold: "PulseDeckBold",
  normal: "PulseDeckNormal",
};

function registerFontIfExists(filePath, family) {
  if (!existsSync(filePath)) return;
  registerFont(filePath, { family });
}

// Register fonts that definitely exist
const BOLD_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
];
const NORMAL_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial Italic.ttf",
  "/System/Library/Fonts/HelveticaNeue.ttc",
];

// Force-register bold fonts; for italic we fallback by just using the family name
// which Pango will try to resolve to a bold variant if it finds one.
for (const p of BOLD_FONTS) {
  try {
    registerFontIfExists(p, FONT_FAMILY.bold);
  } catch { /* ignore */ }
}
for (const p of NORMAL_FONTS) {
  try {
    registerFontIfExists(p, FONT_FAMILY.normal);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Math helpers (mirroring Python)
// ---------------------------------------------------------------------------

function clampValue(value, mode) {
  if (value < 0) return 0;
  if (mode === "percent" && value > 100) return 100;
  if (mode === "temp" && value > 120) return 120;
  return value;
}

function resolveScale(mode, values, current) {
  const allValues = values.concat([current]);
  if (mode === "percent") {
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const paddedMin = Math.max(0, minValue - 4);
    const paddedMax = Math.min(100, maxValue + 4);
    const span = paddedMax - paddedMin;

    if (span >= 24) {
      return { min: paddedMin, max: paddedMax };
    }

    const midpoint = (paddedMin + paddedMax) / 2;
    const halfSpan = 12;
    return {
      min: Math.max(0, midpoint - halfSpan),
      max: Math.min(100, midpoint + halfSpan),
    };
  }

  if (mode === "temp") return { min: 0, max: Math.max(60, ...allValues) };
  if (mode === "latency") return { min: 0, max: Math.max(20, ...allValues) };
  if (mode === "uptime") return { min: 0, max: Math.max(24, ...allValues) };
  return { min: 0, max: Math.max(1, current) };
}

function formatLatency(value) {
  return value < 10 ? [value.toFixed(1), "ms"] : [String(Math.round(value)), "ms"];
}

function formatUptime(hours) {
  if (hours >= 24) return [String(Math.floor(hours / 24)) + "d", String(Math.floor(hours % 24)) + "h"];
  if (hours >= 1) return [hours.toFixed(1), "h"];
  return [String(Math.round(hours * 60)), "m"];
}

// ---------------------------------------------------------------------------
// Drawing functions
// ---------------------------------------------------------------------------

function drawBackground(ctx, accent, soft, options = {}) {
  const showStripes = options.showStripes !== false;

  if (showStripes) {
    // Horizontal gradient lines
    for (let y = 0; y < KEY_SIZE; y++) {
      const t = y / (KEY_SIZE - 1);
      const r = Math.round(18 + (soft[0] * 0.16) + t * 22);
      const g = Math.round(20 + (soft[1] * 0.12) + t * 18);
      const b = Math.round(28 + (soft[2] * 0.1) + t * 20);
      ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
      ctx.fillRect(0, y, KEY_SIZE, 1);
    }
  } else {
    const r = Math.round(26 + (soft[0] * 0.08));
    const g = Math.round(28 + (soft[1] * 0.07));
    const b = Math.round(36 + (soft[2] * 0.06));
    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE);
  }

  // Rounded border outline
  ctx.strokeStyle = "rgba(255,255,255,0.137)";
  ctx.lineWidth = 1;
  const borderR = 20;
  const inset = 2;
  const br = KEY_SIZE - 3;
  ctx.beginPath();
  ctx.moveTo(inset + borderR, inset);
  ctx.lineTo(br - borderR, inset);
  ctx.arcTo(br, inset, br, inset + borderR, borderR);
  ctx.lineTo(br, br - borderR);
  ctx.arcTo(br, br, br - borderR, br, borderR);
  ctx.lineTo(inset + borderR, br);
  ctx.arcTo(inset, br, inset, br - borderR, borderR);
  ctx.lineTo(inset, inset + borderR);
  ctx.arcTo(inset, inset, inset + borderR, inset, borderR);
  ctx.closePath();
  ctx.stroke();

  // Header rectangle
  ctx.save();
  ctx.globalAlpha = 66 / 255;
  ctx.fillStyle = "rgb(" + soft[0] + "," + soft[1] + "," + soft[2] + ")";
  ctx.fillRect(HEADER_LEFT, HEADER_TOP, HEADER_WIDTH, HEADER_HEIGHT);
  ctx.restore();
}

function drawGrid(ctx) {
  for (let step = 0; step < 5; step++) {
    const y = GRAPH_TOP + ((GRAPH_BOTTOM - GRAPH_TOP) * step / 4);
    ctx.strokeStyle = step === 0
      ? "rgba(255,255,255,0.15)"
      : "rgba(255,255,255,0.11)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GRAPH_LEFT, y);
    ctx.lineTo(GRAPH_RIGHT, y);
    ctx.stroke();
  }
}

function drawCenteredText(ctx, text, x, y, font, fillStyle) {
  ctx.font = font;
  ctx.fillStyle = fillStyle;
  ctx.textBaseline = "top";
  const width = ctx.measureText(text).width;
  ctx.fillText(text, x - (width / 2), y);
}

function drawHistory(ctx, history, accent, scale) {
  if (!history || history.length === 0) return;

  // Handle single value - duplicate both ends
  if (history.length === 1) {
    history = [history[0], history[0]];
  }

  const span = Math.max(1, history.length - 1);
  const width = GRAPH_RIGHT - GRAPH_LEFT;
  const height = GRAPH_BOTTOM - GRAPH_TOP;
  const scaleMin = Number.isFinite(scale?.min) ? scale.min : 0;
  const scaleMax = Number.isFinite(scale?.max) ? scale.max : 1;
  const den = Math.max(scaleMax - scaleMin, 0.001);

  // Build points
  const points = new Array(history.length);
  for (let i = 0; i < history.length; i++) {
    const x = GRAPH_LEFT + (width * i / span);
    const normalized = Math.max(0, Math.min(1, (history[i] - scaleMin) / den));
    const y = GRAPH_BOTTOM - (height * normalized);
    points[i] = [x, y];
  }

  // Line connections
  ctx.strokeStyle = "rgba(" + accent[0] + "," + accent[1] + "," + accent[2] + ",0.906)";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 1; i < points.length; i++) {
    ctx.moveTo(points[i - 1][0], points[i - 1][1]);
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();

  // Endpoint dot
  const last = points[points.length - 1];
  const [px, py] = last;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.strokeStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px, py, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawValueWithUnit(ctx, value, unitText, accent) {
  const valueText = String(Math.round(value));
  const valueY = 40;
  const gap = 4;

  ctx.textBaseline = "top";

  // Value text (size 46 bold)
  ctx.font = "46px " + FONT_FAMILY.bold;
  const valueBBox = ctx.measureText(valueText);

  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fillText(valueText, PADDING, valueY);

  // Unit text (size 22 bold, offset right of value)
  ctx.font = "22px " + FONT_FAMILY.bold;
  const unitX = PADDING + valueBBox.width + gap;
  const unitY = valueY + 8;

  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText(unitText, unitX, unitY);
}

function drawLatencyValue(ctx, value, accent) {
  const formatted = formatLatency(value);
  const valueY = 40;

  ctx.textBaseline = "top";
  ctx.font = "40px " + FONT_FAMILY.bold;
  const valueWidth = ctx.measureText(formatted[0]).width;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fillText(formatted[0], PADDING, valueY);

  ctx.font = "22px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText(formatted[1], PADDING + valueWidth + 6, valueY + 10);
}

function drawLabels(ctx, label, value, accent, mode) {
  // Label at top (size 18)
  ctx.font = "18px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgba(232,239,255,0.902)";
  ctx.textBaseline = "top";
  ctx.fillText(label, PADDING, HEADER_TEXT_Y);

  if (mode === "percent") {
    drawValueWithUnit(ctx, value, "%", accent);
    return;
  }

  if (mode === "temp") {
    drawValueWithUnit(ctx, value, "\u00B0C", accent);
    return;
  }

  drawLatencyValue(ctx, value, accent);
}

function drawCenteredBatteryLabels(ctx, label, value, accent) {
  const centerX = KEY_SIZE / 2;
  const valueText = String(Math.round(value));
  const valueY = 50;
  const gap = 4;

  ctx.font = "18px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgba(232,239,255,0.902)";
  ctx.textBaseline = "top";
  ctx.fillText(label, PADDING, HEADER_TEXT_Y);

  ctx.font = "46px " + FONT_FAMILY.bold;
  const valueWidth = ctx.measureText(valueText).width;
  ctx.font = "22px " + FONT_FAMILY.bold;
  const unitWidth = ctx.measureText("%").width;

  const totalWidth = valueWidth + gap + unitWidth;
  const startX = centerX - (totalWidth / 2);

  ctx.font = "46px " + FONT_FAMILY.bold;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fillText(valueText, startX, valueY);

  ctx.font = "22px " + FONT_FAMILY.bold;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText("%", startX + valueWidth + gap, valueY + 8);
}

function drawUptimeLabels(ctx, label, value, accent) {
  const formatted = formatUptime(value);

  ctx.font = "18px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgba(232,239,255,0.902)";
  ctx.textBaseline = "top";
  ctx.fillText(label, PADDING, HEADER_TEXT_Y);

  ctx.font = "34px " + FONT_FAMILY.bold;
  ctx.fillStyle = "rgba(255,255,255,1)";
  const primaryX = PADDING;
  const primaryY = 56;
  ctx.fillText(formatted[0], primaryX, primaryY);

  const primaryWidth = ctx.measureText(formatted[0]).width;
  ctx.font = "24px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText(formatted[1], primaryX + primaryWidth + 8, primaryY + 8);
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render a complete vital tile.
 * Returns a raw PNG buffer.
 */
function render(metric, value, history) {
  const theme = THEMES[metric] || THEMES.cpu;
  const mode = theme.mode;
  const safeValue = clampValue(value, mode);
  const values = history && history.length > 0 ? history.slice(-30) : [safeValue];
  const scale = resolveScale(mode, values, safeValue);

  const canvas = createCanvas(KEY_SIZE, KEY_SIZE);
  const ctx = canvas.getContext("2d");

  const isTextOnlyTile = metric === "battery" || mode === "uptime";
  drawBackground(ctx, theme.accent, theme.accent_soft, { showStripes: !isTextOnlyTile });
  if (metric === "battery") {
    drawCenteredBatteryLabels(ctx, theme.label, safeValue, theme.accent);
  } else if (mode === "uptime") {
    drawUptimeLabels(ctx, theme.label, safeValue, theme.accent);
  } else {
    drawGrid(ctx);
    drawLabels(ctx, theme.label, safeValue, theme.accent, mode);
    drawHistory(ctx, values, theme.accent, scale);
  }

  return canvas.toBuffer("image/png");
}

module.exports = {
  KEY_SIZE,
  render,
};
