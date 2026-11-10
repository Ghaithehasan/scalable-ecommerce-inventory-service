// Consumes Main's exported IDs; connects only to the Inventory database.
const { readFileSync } = require('node:fs');

function validateManifest(value) {
  if (
    !value ||
    value.dataset !== 'ecommerce-demo-v1' ||
    !Array.isArray(value.products) ||
    value.products.length !== 8
  ) {
    throw new Error(
      'Expected an ecommerce-demo-v1 manifest containing exactly 8 products exported by Main',
    );
  }
  const ids = new Set();
  const skus = new Set();
  for (const item of value.products) {
    if (
      !item ||
      typeof item.productId !== 'string' ||
      !/^[1-9]\d{0,9}$/.test(item.productId) ||
      BigInt(item.productId) > 2147483647n ||
      typeof item.sku !== 'string' ||
      !/^DEMO-[A-Z0-9-]+$/.test(item.sku) ||
      typeof item.name !== 'string' ||
      !item.name ||
      item.name.length > 100 ||
      !Number.isInteger(item.initialQuantity) ||
      item.initialQuantity < 0 ||
      item.initialQuantity > 2147483647 ||
      ids.has(item.productId) ||
      skus.has(item.sku)
    ) {
      throw new Error(
        'Invalid or duplicate manifest product: require a Main product ID, unique demo SKU, name, and nonnegative int32 quantity',
      );
    }
    ids.add(item.productId);
    skus.add(item.sku);
  }
  return value;
}

function options(argv) {
  let mode = 'preview';
  let explicitMode = false;
  let manifestPath;
  for (let i = 0; i < argv.length; i++) {
    if (['--preview', '--apply', '--verify'].includes(argv[i])) {
      if (explicitMode)
        throw new Error('Choose only one of --preview, --apply, --verify');
      mode = argv[i].slice(2);
      explicitMode = true;
    } else if (
      argv[i] === '--manifest' &&
      !manifestPath &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    ) {
      manifestPath = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    }
  }
  if (!manifestPath)
    throw new Error(
      'Supply --manifest <path>, or --manifest - to read JSON from stdin',
    );
  return { mode, manifestPath };
}

async function collect(manager, manifest) {
  const rows = await manager.query(
    `SELECT product_id::text AS "productId", available_quantity AS "availableQuantity"
     FROM inventory_stock WHERE product_id = ANY($1::bigint[])`,
    [manifest.products.map((item) => item.productId)],
  );
  const quantities = new Map(
    rows.map((row) => [row.productId, row.availableQuantity]),
  );
  return manifest.products.map((item) => {
    if (!quantities.has(item.productId))
      throw new Error(
        `Missing inventory record for ${item.sku} (product ${item.productId})`,
      );
    return { ...item, availableQuantity: quantities.get(item.productId) };
  });
}

async function seedDemo(dataSource, input) {
  const manifest = validateManifest(input);
  return dataSource.transaction(async (manager) => {
    let inserted = 0;
    for (const item of manifest.products) {
      const rows = await manager.query(
        `INSERT INTO inventory_stock (product_id, available_quantity) VALUES ($1, $2)
         ON CONFLICT (product_id) DO NOTHING RETURNING product_id`,
        [item.productId, item.initialQuantity],
      );
      inserted += rows.length;
    }
    return { inserted, products: await collect(manager, manifest) };
  });
}

async function verifyDemo(dataSource, input) {
  const manifest = validateManifest(input);
  return dataSource.transaction('REPEATABLE READ', async (manager) => {
    await manager.query('SET TRANSACTION READ ONLY');
    return { products: await collect(manager, manifest) };
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  const manifest = validateManifest(
    JSON.parse(
      readFileSync(args.manifestPath === '-' ? 0 : args.manifestPath, 'utf8'),
    ),
  );
  if (args.mode === 'preview') {
    console.log(
      'Preview only: no database connection. Existing stock will never be overwritten.',
    );
    console.table(manifest.products);
    return;
  }
  require('dotenv/config');
  const { default: dataSource } = require('../dist/database/data-source');
  await dataSource.initialize();
  try {
    const result =
      args.mode === 'apply'
        ? await seedDemo(dataSource, manifest)
        : await verifyDemo(dataSource, manifest);
    if (args.mode === 'apply')
      console.log(
        `Inserted ${result.inserted} stock records; preserved ${8 - result.inserted} existing quantities.`,
      );
    else
      console.log(
        'Verified matching Inventory records for all 8 exported Main product IDs.',
      );
    console.table(result.products);
    console.log(
      'initialQuantity is the fixture value; availableQuantity is the current stock and may differ after sales or on existing rows.',
    );
  } finally {
    await dataSource.destroy();
  }
}

module.exports = { seedDemo, verifyDemo, validateManifest, options };
if (require.main === module)
  main().catch((error) => {
    console.error(`Demo seed failed: ${error.message}`);
    process.exitCode = 1;
  });
