#!/bin/sh
# Build the Understudy recorder extension from source — every step, in order.
#
#   sh scripts/build-extension.sh
#
# Needs Node.js 22 or later (with the npm it ships). Output:
#   build/extension/firefox/          the Firefox add-on
#   build/extension/understudy-firefox.zip
#   build/extension/chrome/  + understudy-chrome.zip   (Chrome / Edge)
# See BUILD-EXTENSION.md.
set -eu
cd "$(dirname "$0")/.."

node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("Node.js 22 or later is needed; this is " + process.version); process.exit(1) }'

# 1. Exact dependency versions from package-lock.json (install scripts aren't needed).
npm ci --ignore-scripts

# 2. Re-bundle the one third-party library, dom-accessibility-api, from node_modules
#    into src/adapters/recorder/accname-bundle.ts (esbuild, minified IIFE).
npm run vendor:accname

# 3. Generate extension/recorder.js from src/adapters/recorder/ + that bundle,
#    then write the Chrome and Firefox builds and their zips.
npm run extension:package
