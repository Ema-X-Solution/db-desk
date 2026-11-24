// Checks pg_dump/mysqldump auto-detection against fake Windows-style install folders.
const fs = require('fs'); const path = require('path'); const assert = require('assert'); const os = require('os');
const { findTool } = require('../dist/main/backup');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbdesk-find-'));
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); return p; };
const env = { PATH: path.join(root, 'empty'), LOCALAPPDATA: path.join(root, 'Local'), ProgramFiles: path.join(root, 'PF'), 'ProgramFiles(x86)': path.join(root, 'PF86') };

assert.equal(findTool('pg_dump', undefined, 'win32', env), null, 'nothing installed');

const pgadmin = touch(path.join(root, 'Local', 'Programs', 'pgAdmin 4', 'runtime', 'pg_dump.exe'));
assert.equal(findTool('pg_dump', undefined, 'win32', env), pgadmin, 'pgAdmin 4 runtime (the path on Amr\'s PC)');

touch(path.join(root, 'PF', 'PostgreSQL', '15', 'bin', 'pg_dump.exe'));
const pg17 = touch(path.join(root, 'PF', 'PostgreSQL', '17', 'bin', 'pg_dump.exe'));
touch(path.join(root, 'PF', 'PostgreSQL', '9.6', 'bin', 'pg_dump.exe'));
assert.equal(findTool('pg_dump', undefined, 'win32', env), pg17, 'highest PostgreSQL version wins over pgAdmin');

const onPath = touch(path.join(root, 'bin', 'pg_dump.exe'));
assert.equal(findTool('pg_dump', undefined, 'win32', { ...env, PATH: path.join(root, 'bin') }), onPath, 'PATH wins');

const custom = touch(path.join(root, 'custom', 'pg_dump.exe'));
assert.equal(findTool('pg_dump', custom, 'win32', { ...env, PATH: path.join(root, 'bin') }), custom, 'configured path wins');
assert.equal(findTool('pg_dump', path.join(root, 'gone.exe'), 'win32', env), pg17, 'stale configured path is ignored');

const my = touch(path.join(root, 'PF', 'MySQL', 'MySQL Server 8.0', 'bin', 'mysqldump.exe'));
assert.equal(findTool('mysqldump', undefined, 'win32', env), my);
fs.rmSync(root, { recursive: true });
console.log('find-tool tests passed');
