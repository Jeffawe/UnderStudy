# Building the recorder extension from source

For browser-store reviewers, and anyone who wants to check the published
extension is this code.

## Requirements

- **OS:** macOS or Linux (built and checked on macOS; the steps are plain POSIX shell and Node, so Linux works the same). Windows works under WSL.
- **Node.js 22 or later**, with the npm it ships (built with Node 22.17.0 and npm 10.9.2).
  Install from <https://nodejs.org> (the LTS installer), or with nvm:
  `nvm install 22 && nvm use 22`.
- Internet access for `npm ci`, to download the exact dependency versions in `package-lock.json`.

Nothing else: no global tools, no environment variables.

## Build

From the root of the source:

```sh
sh scripts/build-extension.sh
```

That script runs, in order:

1. `npm ci --ignore-scripts` — installs the locked dependency versions.
2. `npm run vendor:accname` — bundles the third-party library
   [dom-accessibility-api](https://www.npmjs.com/package/dom-accessibility-api)
   0.7.1 (MIT) with esbuild into `src/adapters/recorder/accname-bundle.ts`.
   This is the **only** minified code in the extension.
3. `npm run extension:package` — generates `extension/recorder.js` from the
   hand-written recorder in `src/adapters/recorder/injected.ts` (plain browser
   JavaScript kept as a string, concatenated unchanged) plus that bundle
   (`scripts/build-extension.ts`), then writes the browser builds
   (`scripts/package-extension.mjs`).

## Output

| | |
|---|---|
| Firefox add-on | `build/extension/firefox/` and `build/extension/understudy-firefox.zip` |
| Chrome / Edge | `build/extension/chrome/` and `build/extension/understudy-chrome.zip` |

Compare with the submitted add-on: `diff -r build/extension/firefox <unzipped submission>` reports no differences.

## What's hand-written

`extension/background.js`, `extension/popup.js`, `extension/popup.html`,
`extension/manifest.json` and the icons are hand-written and shipped as they
are. Only `extension/recorder.js` is generated, as above. The Firefox build
differs from the Chrome one only in its manifest: a background script instead
of a service worker, and the add-on id.
