"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifestPath = path.resolve(__dirname, "../com.pshkrh.pulse-deck.sdPlugin/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

assert.equal(manifest.UUID, "com.pshkrh.pulse-deck");
assert.equal(manifest.Name, "Pulse Deck: System Info");
assert.equal(manifest.Category, "System Info");
assert.equal(manifest.CodePath, "bin/plugin.js");
assert.equal(manifest.Nodejs.Version, "20");
assert.ok(Array.isArray(manifest.Actions));
assert.equal(manifest.Actions.length, 5);
assert.equal(manifest.Actions[0].UUID, "com.pshkrh.pulse-deck.cpu");
assert.equal(manifest.Actions[1].UUID, "com.pshkrh.pulse-deck.memory");
assert.equal(manifest.Actions[2].UUID, "com.pshkrh.pulse-deck.ping");
assert.equal(manifest.Actions[2].PropertyInspectorPath, "property-inspector/ping.html");
assert.equal(manifest.Actions[3].UUID, "com.pshkrh.pulse-deck.battery");
assert.equal(manifest.Actions[4].UUID, "com.pshkrh.pulse-deck.uptime");

console.log("manifest tests passed");
