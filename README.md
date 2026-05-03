# Pulse Deck: System Info

<p align="center">
  <img src="docs/media/pulse-deck-logo.svg" alt="Pulse Deck logo" width="900" />
</p>

[![CI](https://github.com/pshkrh/pulse-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/pshkrh/pulse-deck/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/pshkrh/pulse-deck?sort=semver)](https://github.com/pshkrh/pulse-deck/releases)
[![License](https://img.shields.io/github/license/pshkrh/pulse-deck)](./LICENSE)

Pulse Deck is a lightweight Stream Deck plugin for live macOS system info telemetry.

## Demo
![Pulse Deck demo](docs/media/pulse-deck-demo.gif)

## Metrics
- CPU usage (%)
- Memory usage (%)
- Ping latency (ms, `1.1.1.1` with `8.8.8.8` fallback, configurable interval)
- Battery level (%)
- Uptime

## Requirements
- macOS 11+
- Stream Deck 6.5+

## Installation
For other users, install the packaged `.streamDeckPlugin` release artifact through Stream Deck. That package includes the plugin's Node dependencies, so end users do not need to install Node.

Current packaging target:
- Apple Silicon macOS (`arm64`)

Notes:
- CPU temperature uses a bundled Apple Silicon executable at runtime.
- Installing from the repository source is a developer workflow and still requires local tooling.

## Setup
```bash
npm run prepare
npm run icons
npm test
npm run install:local
```
Restart Stream Deck after local install.

## Release Artifact
```bash
npm run package:plugin
```
Output: `dist/com.pshkrh.pulse-deck-<version>-macos-<arch>.streamDeckPlugin`

## Repository Layout
- `com.pshkrh.pulse-deck.sdPlugin/manifest.json`: Stream Deck metadata
- `com.pshkrh.pulse-deck.sdPlugin/bin/plugin.js`: event loop and action wiring
- `com.pshkrh.pulse-deck.sdPlugin/bin/lib/system/metrics.js`: metric collection
- `com.pshkrh.pulse-deck.sdPlugin/bin/lib/render/icon-renderer.js`: tile rendering and cache
- `com.pshkrh.pulse-deck.sdPlugin/bin/lib/render/canvas-renderer.js`: in-process tile renderer
- `com.pshkrh.pulse-deck.sdPlugin/bin/scripts/cpu_temp_bin`: bundled Apple Silicon CPU temperature helper
- `scripts/generate_icons.py`: static icon generation
- `scripts/install-pulse-deck.sh`: local installer
- `scripts/package-plugin.sh`: `.streamDeckPlugin` packager

## Notes
- UUID: `com.pshkrh.pulse-deck`
- Ping interval is configurable in the Ping inspector (default 30s).
- Ping refresh defaults to 30 seconds to keep overhead low.
