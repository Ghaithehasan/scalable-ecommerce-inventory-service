import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { grpcOptions } from './grpc-options';

async function bootstrap() {
  const grpcAddress = process.env.GRPC_BIND ?? '127.0.0.1:50051';

  const app = await NestFactory.createMicroservice(
    AppModule,
    grpcOptions(grpcAddress),
  );
  app.enableShutdownHooks();
  await app.listen();

  console.log(`Inventory gRPC listening at ${grpcAddress}`);
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start Inventory gRPC service', error);
  process.exitCode = 1;
});
