"use strict";

const { createCanvas, registerFont } = require("canvas");
const { existsSync } = require("node:fs");

const KEY_SIZE = 144;
const PADDING  = 12;
const GRAPH_LEFT   = 12;
const GRAPH_RIGHT  = KEY_SIZE - 12;
const GRAPH_TOP    = 64;
const GRAPH_BOTTOM = KEY_SIZE - 22;

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
    label: "BAT",
    accent: [96, 224, 122],
    accent_soft: [145, 245, 169],
    mode: "percent",
  },
  uptime: {
    label: "UP",
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

function resolveScaleMax(mode, values, current) {
  const allValues = values.concat([current]);
  if (mode === "percent") return 100;
  if (mode === "temp") return Math.max(60, ...allValues);
  if (mode === "latency") return Math.max(20, ...allValues);
  if (mode === "uptime") return Math.max(24, ...allValues);
  return Math.max(1, current);
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

function drawBackground(ctx, accent, soft) {
  // Horizontal gradient lines
  for (let y = 0; y < KEY_SIZE; y++) {
    const t = y / (KEY_SIZE - 1);
    const r = Math.round(18 + (soft[0] * 0.16) + t * 22);
    const g = Math.round(20 + (soft[1] * 0.12) + t * 18);
    const b = Math.round(28 + (soft[2] * 0.1) + t * 20);
    ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
    ctx.fillRect(0, y, KEY_SIZE, 1);
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

  // Top-right glow ellipse
  ctx.save();
  ctx.globalAlpha = 58 / 255;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  const ellipseX = KEY_SIZE - 70;
  const ellipseY = -22;
  const ellipseRx = (KEY_SIZE + 34) - (KEY_SIZE - 70);
  const ellipseRy = 80 - (-22);
  ctx.beginPath();
  ctx.ellipse(ellipseX, ellipseY, ellipseRx, ellipseRy, 0, 0, Math.PI * 2);
  ctx.fill();
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

function drawHistory(ctx, history, accent, scaleMax) {
  if (!history || history.length === 0) return;

  // Handle single value - duplicate both ends
  if (history.length === 1) {
    history = [history[0], history[0]];
  }

  const span = Math.max(1, history.length - 1);
  const width = GRAPH_RIGHT - GRAPH_LEFT;
  const height = GRAPH_BOTTOM - GRAPH_TOP;
  const den = Math.max(scaleMax, 0.001);

  // Build points
  const points = new Array(history.length);
  for (let i = 0; i < history.length; i++) {
    const x = GRAPH_LEFT + (width * i / span);
    const y = GRAPH_BOTTOM - (height * (history[i] / den));
    points[i] = [x, y];
  }

  // Area fill (polygon)
  ctx.save();
  ctx.globalAlpha = 40 / 255;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.beginPath();
  ctx.moveTo(GRAPH_LEFT, GRAPH_BOTTOM);
  for (const [x, y] of points) {
    ctx.lineTo(x, y);
  }
  ctx.lineTo(GRAPH_RIGHT, GRAPH_BOTTOM);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

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

  ctx.textBaseline = "top";

  // Value text (size 50 bold)
  ctx.font = "50px " + FONT_FAMILY.bold;
  const valueBBox = ctx.measureText(valueText);

  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fillText(valueText, PADDING, 20);

  // Unit text (size 22 bold, offset right of value)
  ctx.font = "22px " + FONT_FAMILY.bold;
  const unitWidth = ctx.measureText(unitText).width;

  const unitX = PADDING + valueBBox.width + 2;
  const unitY = 46 - unitWidth; // approximate baseline shift to appear ~below

  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText(unitText, unitX, unitY);
}

function drawLabels(ctx, label, value, accent, mode) {
  // Label at top (size 18)
  ctx.font = "18px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgba(232,239,255,0.902)";
  ctx.textBaseline = "top";
  ctx.fillText(label, PADDING, 10);

  if (mode === "percent") {
    drawValueWithUnit(ctx, value, "%", accent);
    return;
  }

  if (mode === "temp") {
    drawValueWithUnit(ctx, value, "\u00B0C", accent);
    return;
  }

  // latency or uptime
  const formatted = mode === "latency" ? formatLatency(value) : formatUptime(value);

  // Value text (size 34)
  ctx.font = "34px " + FONT_FAMILY.bold;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.textBaseline = "top";
  ctx.fillText(formatted[0], PADDING, 24);

  // Unit text (size 15)
  ctx.font = "15px " + FONT_FAMILY.normal;
  ctx.fillStyle = "rgb(" + accent[0] + "," + accent[1] + "," + accent[2] + ")";
  ctx.fillText(formatted[1], PADDING, 54);
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
  const scaleMax = resolveScaleMax(mode, values, safeValue);

  const canvas = createCanvas(KEY_SIZE, KEY_SIZE);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, theme.accent, theme.accent_soft);
  drawGrid(ctx);
  drawLabels(ctx, theme.label, safeValue, theme.accent, mode);
  drawHistory(ctx, values, theme.accent, scaleMax);

  return canvas.toBuffer("image/png");
}

module.exports = {
  KEY_SIZE,
  render,
};
