import { Transport, type GrpcOptions } from '@nestjs/microservices';
import { resolve } from 'node:path';

export function grpcOptions(
  url = process.env.GRPC_BIND ?? '127.0.0.1:50051',
): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      url,
      package: 'inventory.v1',
      protoPath: resolve(
        __dirname,
        '..',
        process.env.INVENTORY_PROTO_PATH ?? 'proto/inventory.proto',
      ),
      loader: { keepCase: false, longs: String },
    },
  };
}
