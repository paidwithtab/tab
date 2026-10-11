// Helpers for scripts/backup.sh, on the built-in node:sqlite.
//   node scripts/backup-sqlite.mjs copy <src.db> <dst.db>   consistent copy with the online backup API
//   node scripts/backup-sqlite.mjs check <file.db>          integrity check, table count, receipt count; exit 1 if not ok
import { DatabaseSync, backup } from 'node:sqlite';

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'copy') {
  const src = new DatabaseSync(a, { readOnly: true });
  await backup(src, b);
  src.close();
} else if (cmd === 'check') {
  const db = new DatabaseSync(a, { readOnly: true });
  const integrity = db.prepare('pragma integrity_check').get().integrity_check;
  const tables = db.prepare("select count(*) as n from sqlite_master where type = 'table'").get().n;
  let receipts = '';
  try {
    receipts = `, ${db.prepare('select count(*) as n from receipts').get().n} receipts`;
  } catch {
    /* not every database has receipts */
  }
  console.log(`  ${a.split('/').pop()}: ${integrity}, ${tables} tables${receipts}`);
  db.close();
  if (integrity !== 'ok') process.exit(1);
} else {
  console.error('usage: backup-sqlite.mjs copy <src> <dst> | check <db>');
  process.exit(2);
}
