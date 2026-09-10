#!/usr/bin/env node
// Runs the compiled CLI. Build first: npm run build
import('../dist/src/cli.js').catch((err) => {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('error: dist/ not found — run `npm run build` first, or use `npm run cli -- ...`');
    process.exit(1);
  }
  throw err;
});
