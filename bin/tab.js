#!/usr/bin/env node
// Runs the compiled CLI. In the npm package dist/ ships prebuilt; in a source
// checkout, run `npm run build` first (or use `npm run cli -- ...` via tsx).

// node:sqlite is stable in behavior but still flagged experimental on some
// Node lines; silence just that warning so `tab` output stays clean.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.error(w);
});

import('../dist/src/cli.js').catch((err) => {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('error: dist/ not found — run `npm run build` first, or use `npm run cli -- ...`');
    process.exit(1);
  }
  throw err;
});
