# Matching demo inventory

The Main API seed creates 3 demo categories, 8 realistic products, and 2 fictional users, then exports their actual product IDs and initial stock quantities. The complete data preview, password handling, Azure container commands, and verification steps are in the Main repository's `docs/demo-seeding.md`.

No schema changes are required. Main allocates IDs through its own SERIAL sequences; never assume IDs 1-8 or reuse a manifest from another environment. Inventory consumes the exported manifest using only its own DB_* settings. Main does not connect to the Inventory database, and Inventory does not connect to Main's database.

## Initial quantities

| Product                          | Initial quantity |
| -------------------------------- | ---------------: |
| Wireless Compact Keyboard        |              120 |
| Ergonomic Wireless Mouse         |                5 |
| 65W USB-C Wall Charger           |                0 |
| Stainless Steel Water Bottle     |               80 |
| Ceramic Coffee Mug               |                3 |
| Digital Kitchen Scale            |                0 |
| A5 Hardcover Notebook            |              200 |
| Adjustable Aluminum Laptop Stand |                2 |

## Local execution

Build the application and run its existing migrations through your normal setup first. Main must export the manifest before Inventory can be seeded.

```powershell
npm.cmd run build
npm.cmd run seed:demo -- --preview --manifest ../e-commerce/demo-inventory.json
npm.cmd run seed:demo -- --apply --manifest ../e-commerce/demo-inventory.json
npm.cmd run seed:demo -- --verify --manifest ../e-commerce/demo-inventory.json
```

Use `npm` on Linux. Preview never connects to a database. Apply inserts missing stock rows in one transaction using `ON CONFLICT (product_id) DO NOTHING`; existing quantities and all reservations are preserved. Verify uses a read-only transaction, reports current stock, and fails on missing records. Reruns do not replenish sold or reserved inventory.

The credential-free manifest has this shape, with eight unique products:

```json
{
  "dataset": "ecommerce-demo-v1",
  "products": [
    {
      "sku": "DEMO-KEYBOARD",
      "name": "Wireless Compact Keyboard",
      "productId": "42",
      "initialQuantity": 120
    }
  ]
}
```

The JSON above is an abbreviated format example; the actual script requires all eight exported products. Product IDs are strings for compatibility with protobuf int64 handling.

## Azure Inventory VM

The runtime image includes `scripts/seed-demo.cjs`. If the running image predates this change, from the Inventory repository copy the script into the existing container:

```bash
inventory_container=$(docker compose -f compose.prod.yaml ps -q inventory)
test -n "$inventory_container" || exit 1
docker cp ./scripts/seed-demo.cjs "$inventory_container":/app/scripts/seed-demo.cjs
```

After securely transferring Main's export to `/tmp/demo-inventory.json` on this VM:

```bash
docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --preview --manifest - < /tmp/demo-inventory.json

docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --apply --manifest - < /tmp/demo-inventory.json

docker compose -f compose.prod.yaml exec -T inventory \
  node scripts/seed-demo.cjs --verify --manifest - < /tmp/demo-inventory.json
```

Only `--apply` writes. No seed is attached to container startup, deployments, or migrations, and no commands are executed against Azure automatically. For existing rows, `availableQuantity` can differ from `initialQuantity`; the difference is reported and preserved.

Run `npm run test:demo-seeds` to exercise both seed scripts against disposable PostgreSQL test databases, including concurrent reruns, bcrypt login compatibility, existing-row preservation, and real gRPC reservations. Docker/Azure execution must be verified in that environment.
