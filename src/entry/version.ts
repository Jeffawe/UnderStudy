/**
 * The package's version, read from package.json — so the CLI's --version and
 * the MCP server's handshake can't drift from what npm installed (the server
 * said 0.2.0 while the package was 0.2.1).
 *
 * package.json is two folders up from both src/entry and dist/entry.
 */

import { readFileSync } from 'node:fs';

export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
