// Every additive role table asserts its exact column list when its module is constructed. All of them are
// written with positional INSERT ... VALUES, so a shape change otherwise starts a controller cleanly and
// then fails at first use with a SQLite column-count error -- far harder to diagnose than a refusal at
// startup. It costs nothing to do everywhere: no live journal has ever created these tables.
const NAME = /^[a-z_]+$/;
export function assertColumns(db, table, columns) {
  // Table names are literals from this source only; never interpolate a caller-supplied name here.
  if (!NAME.test(table)) throw new Error('Invalid schema assertion target');
  const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).join(',');
  if (actual !== columns) throw new Error(`Unsupported ${table} schema; explicit migration required before control starts`);
}
