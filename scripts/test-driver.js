// Starts a throwaway PostgreSQL (embedded-postgres) and exercises the driver end to end.
const EmbeddedPostgres = require('embedded-postgres').default;
const assert = require('assert');
const fs = require('fs');
const { PostgresDriver } = require('../dist/main/db/postgres');
const { pgDump } = require('../dist/main/backup');

(async () => {
  const dir = '/tmp/dbdesk-pg';
  fs.rmSync(dir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54329, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('sales');
  const cfg = { id: 't', name: 't', type: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'sales', ssl: false };
  const d = await PostgresDriver.connect(cfg);
  try {
    const { Client } = require('pg');
    const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'sales' }); await c.connect();
    await c.query(`CREATE TABLE products(id serial primary key, name text not null, price numeric default 0)`);
    await c.query(`INSERT INTO products(name, price) VALUES ('Dress', 450), ('Scarf', 120), ('Weird "name"; DROP TABLE products;--', 1)`);
    await c.query('ANALYZE'); await c.end();

    const tables = await d.listTables(); assert.equal(tables[0].name, 'products');
    assert((await d.databaseSize()) > 0);
    let t = await d.tableData('public', 'products', 50, 0);
    assert.equal(t.total, 3); assert(t.columns.find((x) => x.name === 'id').isPrimaryKey);
    await d.insertRow('public', 'products', { name: 'Belt', price: '90' });
    await d.insertRow('public', 'products', { name: 'Hat' });
    t = await d.tableData('public', 'products', 2, 0); assert.equal(t.total, 5); assert.equal(t.rows.length, 2);
    assert.equal(await d.deleteRow('public', 'products', { id: 1 }), 1);
    assert.equal((await d.tableData('public', 'products', 50, 0)).total, 4);
    try {
      await pgDump(cfg, '/tmp/dbdesk-backup.sql');
      assert(/CREATE TABLE public\.products/.test(fs.readFileSync('/tmp/dbdesk-backup.sql', 'utf8')));
    } catch (e) {
      // pg_dump must be the same version or newer than the server. Skip only on that mismatch.
      if (!/version mismatch/.test(e.message)) throw e;
      console.log('pg_dump skipped: local client older than test server');
    }
    await d.dropTable('public', 'products');
    assert.equal((await d.listTables()).length, 0);
    console.log('driver tests passed');
  } finally { await d.close(); await pg.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
