import type { DataSourceOptions } from 'typeorm';
import { InventoryStockEntity } from '../inventory/entities/inventory-stock.entity';

export function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`);
  return number;
}
export function databaseOptions(
  env: NodeJS.ProcessEnv = process.env,
): Extract<DataSourceOptions, { type: 'postgres' }> {
  for (const name of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']) {
    if (!env[name]) throw new Error(`Missing environment variable: ${name}`);
  }
  return {
    type: 'postgres',
    host: env.DB_HOST,
    port: positiveInteger(env.DB_PORT, 5432, 'DB_PORT'),
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
    entities: [InventoryStockEntity],
    synchronize: false,
    connectTimeoutMS: positiveInteger(
      env.DB_CONNECT_TIMEOUT_MS,
      5000,
      'DB_CONNECT_TIMEOUT_MS',
    ),
    extra: {
      max: positiveInteger(env.DB_POOL_SIZE, 20, 'DB_POOL_SIZE'),
      statement_timeout: positiveInteger(
        env.DB_STATEMENT_TIMEOUT_MS,
        5000,
        'DB_STATEMENT_TIMEOUT_MS',
      ),
      lock_timeout: positiveInteger(
        env.DB_LOCK_TIMEOUT_MS,
        3000,
        'DB_LOCK_TIMEOUT_MS',
      ),
    },
  };
}
