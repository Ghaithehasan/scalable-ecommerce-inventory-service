const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const path = require('node:path');
const definition = loader.loadSync(
  path.resolve(__dirname, '../proto/inventory.proto'),
  { longs: String, keepCase: false },
);
const pkg = grpc.loadPackageDefinition(definition);
const port = (process.env.GRPC_BIND ?? '0.0.0.0:50051').split(':').pop();
const client = new pkg.inventory.v1.InventoryService(
  `127.0.0.1:${port}`,
  grpc.credentials.createInsecure(),
);
client.GetStocks(
  // A nonempty batch verifies database access even when product 1 is absent.
  { productIds: ['1'] },
  { deadline: Date.now() + 1500 },
  (error) => {
    client.close();
    process.exitCode = error ? 1 : 0;
  },
);
