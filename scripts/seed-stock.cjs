// Initial provisioning only: existing stock is never overwritten.
require('dotenv/config');
const { default: dataSource } = require('../dist/database/data-source');
const { productId } = require('../dist/inventory/inventory.validation');
const entries = process.argv.slice(2).map((argument) => {
  const [id, value, extra] = argument.split(':');
  const quantity = Number(value);
  if (
    extra !== undefined ||
    value === undefined ||
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > 2147483647
  )
    throw new Error('Use productId:quantity, e.g. 1:20 2:10');
  return { id: productId(id), quantity };
});
if (!entries.length) throw new Error('Supply at least one productId:quantity');
(async () => {
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      for (const item of entries)
        await manager.query(
          `INSERT INTO inventory_stock(product_id, available_quantity) VALUES ($1,$2) ON CONFLICT (product_id) DO NOTHING`,
          [item.id, item.quantity],
        );
    });
    console.log(
      'Stock records provisioned; existing quantities were preserved.',
    );
  } finally {
    await dataSource.destroy();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
