import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { StockItem } from './inventory.types';

export const MAX_ITEMS = 100;
const INT64_MAX = 9223372036854775807n;
const INT32_MAX = 2147483647;
function invalid(message: string): never {
  throw new RpcException({ code: status.INVALID_ARGUMENT, message });
}
export function productId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{1,19}$/.test(value)) {
    return invalid('product_id must be a positive int64 encoded as a string');
  }
  const id = BigInt(value);
  if (id <= 0n || id > INT64_MAX)
    return invalid('product_id is outside the positive int64 range');
  return id.toString();
}
export function reservationId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) {
    return invalid(
      'reservation_id must be a nonempty string of at most 100 characters',
    );
  }
  return value;
}
export function stockItems(value: unknown): StockItem[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ITEMS) {
    return invalid(`items must contain between 1 and ${MAX_ITEMS} products`);
  }
  const seen = new Set<string>();
  const items = value.map((item: unknown): StockItem => {
    if (!item || typeof item !== 'object') return invalid('Invalid stock item');
    const input = item as Record<string, unknown>;
    const id = productId(input.productId);
    if (seen.has(id)) return invalid(`Duplicate product_id ${id}`);
    if (
      typeof input.quantity !== 'number' ||
      !Number.isInteger(input.quantity) ||
      input.quantity <= 0 ||
      input.quantity > INT32_MAX
    )
      return invalid('quantity must be a positive int32');
    seen.add(id);
    return { productId: id, quantity: input.quantity };
  });
  return items.sort((a, b) =>
    BigInt(a.productId) < BigInt(b.productId) ? -1 : 1,
  );
}
