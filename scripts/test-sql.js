// Exercises the SQL tab backend against a throwaway PostgreSQL.
const EmbeddedPostgres = require('embedded-postgres').default;
const assert = require('assert');
const fs = require('fs');
const { PostgresDriver } = require('../dist/main/db/postgres');
const { checkScript, stripSql } = require('../dist/main/db/script');

(async () => {
  // Pure checks (no server needed)
  assert.throws(() => checkScript('postgres', 'BEGIN; DELETE FROM t; COMMIT;', false), /Remove the transaction line/);
  assert.throws(() => checkScript('postgres', 'delete from t; rollback', false), /Remove the transaction line/);
  assert.throws(() => checkScript('postgres', '  -- only a comment', false), /no statements/);
  assert.throws(() => checkScript('postgres', '   ', false), /empty/);
  checkScript('postgres', "SELECT 'commit; begin;' AS s /* commit; */ -- end;\n; DO $$ BEGIN PERFORM 1; END $$;", false); // quoted words are fine
  assert.throws(() => checkScript('mysql', 'ALTER TABLE a ADD b INT', false), /cannot undo/);
  checkScript('mysql', 'ALTER TABLE a ADD b INT', true);
  assert.throws(() => checkScript('mssql', 'BEGIN TRAN; DELETE FROM t', true), /Remove the transaction line/);
  checkScript('mssql', 'IF 1=1 BEGIN SELECT 1 END', false); // plain BEGIN is a T-SQL block, allowed
  assert(!/commit/.test(stripSql("select 'commit' -- commit")));

  const dir = '/tmp/dbdesk-pg-sql';
  fs.rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54331, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('sales');
  const d = await PostgresDriver.connect({ id: 't', name: 't', type: 'postgres', host: '127.0.0.1', port: 54331, user: 'postgres', password: 'pw', database: 'sales', ssl: false });
  const count = async () => (await d.tableData('public', 'items', 50, 0)).total;
  try {
    await d.runScript("CREATE TABLE items(id serial primary key, name text, qty int); INSERT INTO items(name, qty) VALUES ('a',1),('b',2),('test',3),('test',4)", true);
    assert.equal(await count(), 4);

    // Dry run: runs everything, reports counts, saves nothing
    let r = await d.runScript("DELETE FROM items WHERE name = 'test'; SELECT count(*) AS n, 'x' AS n FROM items", false);
    assert.equal(r.committed, false); assert.equal(r.results.length, 2);
    assert.equal(r.results[0].command, 'DELETE'); assert.equal(r.results[0].rowCount, 2);
    assert.deepEqual(r.results[1].columns, ['n', 'n']); assert.deepEqual(r.results[1].rows, [['2', 'x']]);
    assert.equal(await count(), 4, 'dry run must not change data');

    // Failure in the middle rolls everything back, even with commit=true
    await assert.rejects(d.runScript("DELETE FROM items WHERE name = 'test'; SELECT * FROM missing_table", true), /missing_table/);
    assert.equal(await count(), 4, 'failed script must roll back');
    // The connection still works after an error
    assert.equal(await count(), 4);

    // Commit
    r = await d.runScript("DELETE FROM items WHERE name = 'test'", true);
    assert.equal(r.committed, true); assert.equal(await count(), 2);

    // Row cap
    r = await d.runScript('SELECT g FROM generate_series(1, 500) g', false);
    assert.equal(r.results[0].rows.length, 200); assert.equal(r.results[0].truncated, true); assert.equal(r.results[0].rowCount, 500);

    // Script-supplied transaction control is refused before touching the database
    await assert.rejects(d.runScript('BEGIN; DELETE FROM items; COMMIT;', true), /Remove the transaction line/);
    assert.equal(await count(), 2);
    console.log('sql tab tests passed');
  } finally { await d.close(); await pg.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
