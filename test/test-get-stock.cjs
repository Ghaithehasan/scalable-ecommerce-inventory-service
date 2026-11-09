
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('node:path');

const protoPath = path.resolve(
  __dirname,
  '../proto/inventory.proto',
);

const definition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
});

const proto = grpc.loadPackageDefinition(definition);

const client = new proto.inventory.v1.InventoryService(
  '127.0.0.1:50051',
  grpc.credentials.createInsecure(),
);

const getStock = client.getStock ?? client.GetStock;

getStock.call(
  client,
  { productId: '10' },
  (error, response) => {
    if (error) {
      console.error('gRPC Error:', error);
    } else {
      console.log('Inventory Response:', response);
    }

    client.close();
  },
);
