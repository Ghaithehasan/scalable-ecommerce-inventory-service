import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { Logger, type INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { InventoryService as ServiceType } from '../src/inventory/inventory.service';

const { InventoryModule } = require('../dist/inventory/inventory.module');
const { InventoryService } = require('../dist/inventory/inventory.service');
const {
  InventoryStockEntity,
} = require('../dist/inventory/entities/inventory-stock.entity');
const {
  CreateInventoryTables1762700000000,
} = require('../dist/database/migrations/1762700000000-CreateInventoryTables');
const {
  AddCancellationState1794268800001,
} = require('../dist/database/migrations/1794268800001-AddCancellationState');
const { grpcOptions } = require('../dist/grpc-options');

export function testUrl(name: string, prefix: string): string {
  const value = process.env[name];
  if (
    !value ||
    !new RegExp(`^${prefix}(?:_|$)`).test(new URL(value).pathname.slice(1))
  )
    throw new Error(
      `${name} must point to a dedicated ${prefix} database. Run npm run test:db.`,
    );
  return value;
}
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((accept) => server.close(() => accept()));
  return port;
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export interface Harness {
  app: INestMicroservice;
  db: DataSource;
  service: ServiceType;
  address: string;
  call<T = any>(
    method: string,
    request: object,
    timeoutMs?: number,
  ): Promise<T>;
  reset(): Promise<void>;
  quantity(id: string): Promise<number>;
  close(): Promise<void>;
}
export async function inventoryHarness(): Promise<Harness> {
  Logger.overrideLogger(false);
  const url = testUrl('TEST_DATABASE_URL', 'inventory_test');
  const schema = `inv_test_${randomUUID().replace(/-/g, '')}`;
  const admin = await new DataSource({ type: 'postgres', url }).initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const module = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        url,
        schema,
        extra: {
          options: `-c search_path=${schema}`,
          max: 30,
          statement_timeout: 10000,
          lock_timeout: 5000,
        },
        entities: [InventoryStockEntity],
        migrations: [
          CreateInventoryTables1762700000000,
          AddCancellationState1794268800001,
        ],
        migrationsRun: true,
        synchronize: false,
      }),
      InventoryModule,
    ],
  }).compile();
  const address = `127.0.0.1:${await freePort()}`;
  const app = module.createNestMicroservice(grpcOptions(address));
  await app.listen();
  const pkg = grpc.loadPackageDefinition(
    loader.loadSync(resolve(__dirname, '../proto/inventory.proto'), {
      keepCase: false,
      longs: String,
      arrays: true,
    }),
  ) as any;
  const client = new pkg.inventory.v1.InventoryService(
    address,
    grpc.credentials.createInsecure(),
  );
  const db = module.get<DataSource>(DataSource);
  return {
    app,
    db,
    address,
    service: module.get<ServiceType>(InventoryService),
    call: (method, request, timeoutMs = 5000) =>
      new Promise((accept, reject) => {
        client[method](
          request,
          { deadline: Date.now() + timeoutMs },
          (error: grpc.ServiceError | null, response: any) =>
            error ? reject(error) : accept(response),
        );
      }),
    async reset() {
      await db.query(
        'TRUNCATE inventory_reservation_items, inventory_reservations, inventory_stock',
      );
      await db.query(
        `INSERT INTO inventory_stock(product_id, available_quantity) VALUES (10, 10), (20, 10), (9007199254740993, 7)`,
      );
    },
    async quantity(id) {
      const [row] = await db.query(
        'SELECT available_quantity FROM inventory_stock WHERE product_id = $1',
        [id],
      );
      return row.available_quantity;
    },
    async close() {
      client.close();
      await app.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    },
  };
}
