// Starts a disposable local PostgreSQL cluster, or uses explicitly supplied
// TEST_* URLs. It never reads .env or touches an application's database.
const { spawnSync, execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const net = require('node:net');
const { Client } = require('pg');
const root = resolve(__dirname, '..');

function run(file, args, cwd = root, env = process.env) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${file} exited with ${result.status}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}
function binaries() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (process.platform === 'win32') {
    const base = 'C:/Program Files/PostgreSQL';
    if (existsSync(base))
      return join(
        base,
        readdirSync(base)
          .filter((name) => /^\d+$/.test(name))
          .sort((a, b) => Number(b) - Number(a))[0],
        'bin',
      );
  }
  try {
    return execFileSync('pg_config', ['--bindir'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error(
      'Set PG_BIN to PostgreSQL binaries, or supply TEST_DATABASE_URL and TEST_MAIN_DATABASE_URL. See README.',
    );
  }
}

(async () => {
  const env = { ...process.env };
  const inventoryOnly = process.argv.includes('--inventory-only');
  let data,
    pgctl,
    startAttempted = false;
  try {
    if (
      !env.TEST_DATABASE_URL ||
      (!inventoryOnly && !env.TEST_MAIN_DATABASE_URL)
    ) {
      const bin = binaries();
      const exe = (name) =>
        join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
      const port = await freePort();
      // Windows PostgreSQL command-line tools require an ASCII data path.
      const folder = mkdtempSync(join(tmpdir(), 'inventory-pg-tests-'));
      data = join(folder, 'data');
      pgctl = exe('pg_ctl');
      run(exe('initdb'), [
        '-D',
        data,
        '-U',
        'test_admin',
        '-A',
        'trust',
        '-E',
        'UTF8',
        '--locale=C',
        '--no-instructions',
      ]);
      startAttempted = true;
      run(pgctl, [
        '-D',
        data,
        '-l',
        join(folder, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -c fsync=off -c max_connections=100`,
        '-w',
        '-t',
        '15',
        'start',
      ]);
      const admin = new Client({
        host: '127.0.0.1',
        port,
        user: 'test_admin',
        database: 'postgres',
      });
      await admin.connect();
      try {
        await admin.query('CREATE ROLE inventory_test_role LOGIN');
        await admin.query('CREATE ROLE ecommerce_test_role LOGIN');
        await admin.query(
          'CREATE DATABASE inventory_test OWNER inventory_test_role',
        );
        await admin.query(
          'CREATE DATABASE ecommerce_test OWNER ecommerce_test_role',
        );
      } finally {
        await admin.end();
      }
      env.TEST_DATABASE_URL = `postgresql://inventory_test_role@127.0.0.1:${port}/inventory_test`;
      env.TEST_MAIN_DATABASE_URL = `postgresql://ecommerce_test_role@127.0.0.1:${port}/ecommerce_test`;
      console.log(
        'Using a disposable PostgreSQL cluster; application .env files are not used.',
      );
    }
    const mainArgument = process.argv.indexOf('--main-api');
    const mainRoot = resolve(
      env.MAIN_API_DIR ??
        (mainArgument >= 0
          ? process.argv[mainArgument + 1]
          : join(root, '../e-commerce')),
    );
    env.MAIN_API_DIR = mainRoot;
    run(
      process.execPath,
      ['node_modules/@nestjs/cli/bin/nest.js', 'build'],
      root,
      env,
    );
    if (!inventoryOnly) {
      if (!existsSync(join(mainRoot, 'package.json')))
        throw new Error(
          'Main API not found. Set MAIN_API_DIR or use --inventory-only.',
        );
      run(
        process.execPath,
        ['node_modules/@nestjs/cli/bin/nest.js', 'build'],
        mainRoot,
        env,
      );
    }
    const files = inventoryOnly
      ? ['test/inventory.e2e-spec.ts']
      : process.argv.includes('--demo-seeds-only')
        ? ['test/demo-seeds.e2e-spec.ts']
        : [];
    run(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.e2e.mts',
        ...files,
      ],
      root,
      env,
    );
  } finally {
    if (startAttempted) {
      const stopped = spawnSync(
        pgctl,
        ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'],
        { stdio: 'inherit', windowsHide: true },
      );
      if (stopped.status !== 0) process.exitCode = 1;
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
