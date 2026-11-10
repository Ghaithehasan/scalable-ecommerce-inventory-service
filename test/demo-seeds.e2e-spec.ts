import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inventoryHarness, testUrl, type Harness } from './inventory-harness';

const mainRoot = resolve(process.env.MAIN_API_DIR ?? '../e-commerce');
const main = createRequire(resolve(mainRoot, 'package.json'));
const load = (path: string) => main(resolve(mainRoot, 'dist', path));
const { DataSource } = main('typeorm');
const bcrypt = main('bcrypt');
const mainSeed = main(resolve(mainRoot, 'scripts/seed-demo.cjs'));
const inventorySeed = require('../scripts/seed-demo.cjs');
const passwords = {
  DEMO_CUSTOMER_PASSWORD: 'local-fixture-customer-2026',
  DEMO_MANAGER_PASSWORD: 'local-fixture-manager-2026',
};

describe('manual demo seeds with separate PostgreSQL databases', () => {
  let mainDb: any;
  let inventory: Harness;

  beforeAll(async () => {
    mainDb = await new DataSource({
      type: 'postgres',
      url: testUrl('TEST_MAIN_DATABASE_URL', 'ecommerce_test'),
      migrations: [
        load('migrations/1793744493449-InitialSchema')
          .InitialSchema1793744493449,
        load('migrations/1794268800000-AddInventoryOrderOperations')
          .AddInventoryOrderOperations1794268800000,
      ],
      migrationsRun: true,
      synchronize: false,
    }).initialize();
    inventory = await inventoryHarness();
  });

  afterAll(async () => {
    if (inventory) await inventory.close();
    if (mainDb) await mainDb.destroy();
  });

  beforeEach(async () => {
    // These URLs are guarded dedicated TEST_* databases in a disposable cluster.
    await mainDb.query(
      'TRUNCATE inventory_order_operations, order_items, orders, product_images, products, categories, users RESTART IDENTITY CASCADE',
    );
    await inventory.db.query(
      'TRUNCATE inventory_reservation_items, inventory_reservations, inventory_stock',
    );
  });

  it('creates matching records, supports login hashes, and never resets sold or reserved stock on rerun', async () => {
    const seeded = await mainSeed.seedDemo(mainDb, passwords);
    expect(seeded.inserted).toEqual({ categories: 3, products: 8, users: 2 });
    expect(
      new Set(seeded.manifest.products.map((p: any) => p.productId)).size,
    ).toBe(8);
    expect(seeded.manifest.products.map((p: any) => p.initialQuantity)).toEqual(
      [120, 5, 0, 80, 3, 0, 200, 2],
    );

    const users = await mainDb.query(
      'SELECT email, role, "passwordHash" FROM users ORDER BY email',
    );
    expect(users).toHaveLength(2);
    const customer = users.find(
      (u: any) => u.email === 'maya.customer@example.com',
    );
    const manager = users.find(
      (u: any) => u.email === 'omar.manager@example.com',
    );
    expect(customer.role).toBe('CUSTOMER');
    expect(manager.role).toBe('RESPONSIBLE');
    expect(bcrypt.getRounds(customer.passwordHash)).toBe(12);
    expect(
      await bcrypt.compare(
        passwords.DEMO_CUSTOMER_PASSWORD,
        customer.passwordHash,
      ),
    ).toBe(true);
    expect(
      await bcrypt.compare(
        passwords.DEMO_MANAGER_PASSWORD,
        manager.passwordHash,
      ),
    ).toBe(true);

    const stock = await inventorySeed.seedDemo(inventory.db, seeded.manifest);
    expect(stock.inserted).toBe(8);
    expect(stock.products.map((p: any) => p.availableQuantity)).toEqual([
      120, 5, 0, 80, 3, 0, 200, 2,
    ]);
    const mouse = seeded.manifest.products.find(
      (p: any) => p.sku === 'DEMO-MOUSE',
    );
    await inventory.call('ReserveStock', {
      reservationId: randomUUID(),
      items: [{ productId: mouse.productId, quantity: 2 }],
    });
    expect(await inventory.quantity(mouse.productId)).toBe(3);

    const keyboard = seeded.manifest.products[0];
    await mainDb.query('UPDATE products SET price = 35.50 WHERE id = $1', [
      keyboard.productId,
    ]);
    const again = await mainSeed.seedDemo(mainDb, {
      DEMO_CUSTOMER_PASSWORD: 'different-password-should-not-replace',
      DEMO_MANAGER_PASSWORD: 'different-password-should-not-replace',
    });
    expect(again.inserted).toEqual({ categories: 0, products: 0, users: 0 });
    expect(again.manifest).toEqual(seeded.manifest);
    expect(
      (
        await mainDb.query('SELECT price::text FROM products WHERE id = $1', [
          keyboard.productId,
        ])
      )[0].price,
    ).toBe('35.50');
    const customerAfter = (
      await mainDb.query('SELECT "passwordHash" FROM users WHERE email = $1', [
        'maya.customer@example.com',
      ])
    )[0];
    expect(customerAfter.passwordHash).toBe(customer.passwordHash);
    expect(
      (await inventorySeed.seedDemo(inventory.db, seeded.manifest)).inserted,
    ).toBe(0);
    expect(await inventory.quantity(mouse.productId)).toBe(3);
    expect(
      (
        await inventory.db.query(
          'SELECT count(*)::int AS n FROM inventory_reservations',
        )
      )[0].n,
    ).toBe(1);
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM orders'))[0].n,
    ).toBe(0);
  });

  it('serializes concurrent reruns without duplicate Main products or Inventory stock', async () => {
    const [first, second] = await Promise.all([
      mainSeed.seedDemo(mainDb, passwords),
      mainSeed.seedDemo(mainDb, passwords),
    ]);
    expect(first.inserted.products + second.inserted.products).toBe(8);
    expect(first.manifest).toEqual(second.manifest);
    const [a, b] = await Promise.all([
      inventorySeed.seedDemo(inventory.db, first.manifest),
      inventorySeed.seedDemo(inventory.db, first.manifest),
    ]);
    expect(a.inserted + b.inserted).toBe(8);
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM products'))[0].n,
    ).toBe(8);
    expect(
      (
        await inventory.db.query(
          'SELECT count(*)::int AS n FROM inventory_stock',
        )
      )[0].n,
    ).toBe(8);
  });

  it('uses generated IDs and preserves unrelated data in both databases', async () => {
    const [category] = await mainDb.query(
      `INSERT INTO categories(name, slug, is_active) VALUES ('Existing', 'existing', true) RETURNING id`,
    );
    const [otherProduct] = await mainDb.query(
      `INSERT INTO products(name, description, price, category_id, is_active)
       VALUES ('Existing Product', 'Keep this product', 77.00, $1, true) RETURNING id`,
      [category.id],
    );
    await inventory.db.query(
      'INSERT INTO inventory_stock(product_id, available_quantity) VALUES (777, 9)',
    );
    const seeded = await mainSeed.seedDemo(mainDb, passwords);
    expect(
      seeded.manifest.products.every(
        (p: any) => Number(p.productId) > otherProduct.id,
      ),
    ).toBe(true);
    await inventorySeed.seedDemo(inventory.db, seeded.manifest);
    expect(
      (
        await mainDb.query(
          'SELECT name, price::text FROM products WHERE id = $1',
          [otherProduct.id],
        )
      )[0],
    ).toEqual({ name: 'Existing Product', price: '77.00' });
    expect(await inventory.quantity('777')).toBe(9);
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM products'))[0].n,
    ).toBe(9);
    expect(
      (
        await inventory.db.query(
          'SELECT count(*)::int AS n FROM inventory_stock',
        )
      )[0].n,
    ).toBe(9);
  });

  it('rolls back all Main inserts if a new user password is missing or weak', async () => {
    await expect(
      mainSeed.seedDemo(mainDb, {
        DEMO_CUSTOMER_PASSWORD: passwords.DEMO_CUSTOMER_PASSWORD,
        DEMO_MANAGER_PASSWORD: 'short',
      }),
    ).rejects.toThrow('DEMO_MANAGER_PASSWORD');
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM categories'))[0].n,
    ).toBe(0);
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM products'))[0].n,
    ).toBe(0);
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM users'))[0].n,
    ).toBe(0);
  });

  it('rejects reserved slug and email collisions without modifying existing accounts', async () => {
    await mainDb.query(
      `INSERT INTO categories(name, slug, is_active) VALUES ('Unrelated', 'demo-electronics', true)`,
    );
    await expect(mainSeed.seedDemo(mainDb, passwords)).rejects.toThrow(
      'slug collision',
    );
    expect(
      (
        await mainDb.query('SELECT name FROM categories WHERE slug = $1', [
          'demo-electronics',
        ])
      )[0].name,
    ).toBe('Unrelated');
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM products'))[0].n,
    ).toBe(0);
    await mainDb.query('DELETE FROM categories WHERE slug = $1', [
      'demo-electronics',
    ]);
    const hash = await bcrypt.hash('existing-account-passphrase', 12);
    await mainDb.query(
      `INSERT INTO users(name, email, gender, "passwordHash", role)
       VALUES ('Unrelated User', 'maya.customer@example.com', 'FEMALE', $1, 'CUSTOMER')`,
      [hash],
    );
    await expect(mainSeed.seedDemo(mainDb, passwords)).rejects.toThrow(
      'email collision',
    );
    expect(
      (
        await mainDb.query(
          'SELECT name, "passwordHash" FROM users WHERE email = $1',
          ['maya.customer@example.com'],
        )
      )[0],
    ).toEqual({ name: 'Unrelated User', passwordHash: hash });
    expect(
      (await mainDb.query('SELECT count(*)::int AS n FROM products'))[0].n,
    ).toBe(0);
  });

  it('verifies without writing and rejects incomplete Inventory manifests', async () => {
    await expect(mainSeed.verifyDemo(mainDb)).rejects.toThrow(
      'Missing demo category',
    );
    const seeded = await mainSeed.seedDemo(mainDb, passwords);
    expect((await mainSeed.verifyDemo(mainDb)).manifest).toEqual(
      seeded.manifest,
    );
    await expect(
      inventorySeed.verifyDemo(inventory.db, seeded.manifest),
    ).rejects.toThrow('Missing inventory record');
    expect(() =>
      inventorySeed.validateManifest({
        ...seeded.manifest,
        products: seeded.manifest.products.slice(0, 7),
      }),
    ).toThrow('exactly 8');
    const bad = JSON.parse(JSON.stringify(seeded.manifest));
    bad.products[1].productId = bad.products[0].productId;
    expect(() => inventorySeed.validateManifest(bad)).toThrow('duplicate');
    expect(
      (
        await inventory.db.query(
          'SELECT count(*)::int AS n FROM inventory_stock',
        )
      )[0].n,
    ).toBe(0);
  });

  it('shows both previews with invalid database settings and performs no writes', async () => {
    const env = {
      ...process.env,
      DB_HOST: 'invalid.invalid',
      DB_USERNAME: '',
      DB_PASSWORD: '',
      DB_DATABASE: '',
    };
    const mainPreview = spawnSync(
      process.execPath,
      [resolve(mainRoot, 'scripts/seed-demo.cjs'), '--preview'],
      { env, encoding: 'utf8', windowsHide: true },
    );
    expect(mainPreview.status).toBe(0);
    expect(mainPreview.stdout).toContain('Wireless Compact Keyboard');
    const seeded = await mainSeed.seedDemo(mainDb, passwords);
    const inventoryPreview = spawnSync(
      process.execPath,
      [
        resolve(__dirname, '../scripts/seed-demo.cjs'),
        '--preview',
        '--manifest',
        '-',
      ],
      {
        env,
        encoding: 'utf8',
        input: JSON.stringify(seeded.manifest),
        windowsHide: true,
      },
    );
    expect(inventoryPreview.status).toBe(0);
    expect(inventoryPreview.stdout).toContain('productId');
    expect(
      (
        await inventory.db.query(
          'SELECT count(*)::int AS n FROM inventory_stock',
        )
      )[0].n,
    ).toBe(0);
  });

  it('runs the manual CLIs against the two isolated databases and exports the real IDs', async () => {
    const mainUrl = new URL(
      testUrl('TEST_MAIN_DATABASE_URL', 'ecommerce_test'),
    );
    const inventoryUrl = new URL(
      testUrl('TEST_DATABASE_URL', 'inventory_test'),
    );
    const dbEnv = (url: URL) => ({
      DB_HOST: url.hostname,
      DB_PORT: url.port,
      DB_USERNAME: decodeURIComponent(url.username),
      DB_PASSWORD: 'local-disposable-cluster-only',
      DB_DATABASE: url.pathname.slice(1),
      DB_SSL: 'false',
    });
    const mainEnv = { ...process.env, ...dbEnv(mainUrl), ...passwords };
    const inventoryEnv = {
      ...process.env,
      ...dbEnv(inventoryUrl),
      PGOPTIONS: `-c search_path=${(inventory.db.options as { schema: string }).schema}`,
    };
    const manifestPath = join(
      tmpdir(),
      `demo-inventory-test-${randomUUID()}.json`,
    );
    try {
      const mainApply = spawnSync(
        process.execPath,
        [
          resolve(mainRoot, 'scripts/seed-demo.cjs'),
          '--apply',
          '--export',
          manifestPath,
        ],
        {
          env: mainEnv,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(mainApply.status, mainApply.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.products).toHaveLength(8);
      expect(new Set(manifest.products.map((p: any) => p.productId)).size).toBe(
        8,
      );
      const inventoryApply = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../scripts/seed-demo.cjs'),
          '--apply',
          '--manifest',
          manifestPath,
        ],
        {
          env: inventoryEnv,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(inventoryApply.status, inventoryApply.stderr).toBe(0);
      expect(inventoryApply.stdout).toContain('Inserted 8 stock records');
      const mainVerify = spawnSync(
        process.execPath,
        [
          resolve(mainRoot, 'scripts/seed-demo.cjs'),
          '--verify',
          '--export',
          manifestPath,
        ],
        {
          env: mainEnv,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(mainVerify.status, mainVerify.stderr).toBe(0);
      const inventoryVerify = spawnSync(
        process.execPath,
        [
          resolve(__dirname, '../scripts/seed-demo.cjs'),
          '--verify',
          '--manifest',
          manifestPath,
        ],
        {
          env: inventoryEnv,
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(inventoryVerify.status, inventoryVerify.stderr).toBe(0);
      expect(inventoryVerify.stdout).toContain(
        'all 8 exported Main product IDs',
      );
    } finally {
      if (existsSync(manifestPath)) unlinkSync(manifestPath);
    }
  });
});
