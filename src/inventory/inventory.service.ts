import { status } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { InventoryStockEntity } from './entities/inventory-stock.entity';
import type {
  GetStockResponse,
  GetStocksResponse,
  ReleaseStockResponse,
  ReserveStockRequest,
  ReserveStockResponse,
  StockItem,
} from './inventory.types';
import * as validate from './inventory.validation';

export type {
  ReserveStockRequest,
  ReserveStockResponse,
  StockItem,
} from './inventory.types';
type Reservation = { status: 'RESERVED' | 'RELEASED' | 'CANCELLED' };
type StockUpdate = [{ product_id: string }[], number];

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  constructor(
    @InjectRepository(InventoryStockEntity)
    private readonly stockRepository: Repository<InventoryStockEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async getStock(value: unknown): Promise<GetStockResponse> {
    const productId = validate.productId(value);
    const stock = await this.stockRepository.findOneBy({ productId });
    if (!stock)
      throw new RpcException({
        code: status.NOT_FOUND,
        message: `Inventory record for product ${productId} not found`,
      });
    return {
      productId: stock.productId,
      availableQuantity: stock.availableQuantity,
    };
  }

  async getStocks(value: unknown): Promise<GetStocksResponse> {
    if (!Array.isArray(value) || value.length > validate.MAX_ITEMS) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: `product_ids must be an array of at most ${validate.MAX_ITEMS} IDs`,
      });
    }
    const ids = [...new Set(value.map(validate.productId))];
    if (!ids.length) return { items: [] };
    const stocks = await this.stockRepository.findBy({ productId: In(ids) });
    return {
      items: stocks
        .map((stock) => ({
          productId: stock.productId,
          availableQuantity: stock.availableQuantity,
        }))
        .sort((a, b) => (BigInt(a.productId) < BigInt(b.productId) ? -1 : 1)),
    };
  }

  async reserveStock(
    request: ReserveStockRequest,
  ): Promise<ReserveStockResponse> {
    const reservationId = validate.reservationId(request?.reservationId);
    const items = validate.stockItems(request?.items);
    const response = await this.dataSource.transaction(
      'READ COMMITTED',
      async (manager) => {
        // Insert the identity BEFORE stock updates. Uniqueness waits for any
        // uncommitted reserve/cancellation of this ID, across all instances.
        const inserted = await manager.query<{ reservation_id: string }[]>(
          `
        INSERT INTO inventory_reservations (reservation_id, status)
        VALUES ($1, 'RESERVED') ON CONFLICT (reservation_id) DO NOTHING
        RETURNING reservation_id`,
          [reservationId],
        );
        const [reservation] = await manager.query<Reservation[]>(
          `
        SELECT status FROM inventory_reservations
        WHERE reservation_id = $1 FOR UPDATE`,
          [reservationId],
        );
        if (!reservation || reservation.status !== 'RESERVED') {
          throw new RpcException({
            code: status.FAILED_PRECONDITION,
            message:
              'Reservation was cancelled or released; use a new logical operation',
          });
        }
        if (!inserted.length) {
          const original = await manager.query<StockItem[]>(
            `
          SELECT product_id::text AS "productId", quantity
          FROM inventory_reservation_items WHERE reservation_id = $1
          ORDER BY product_id`,
            [reservationId],
          );
          if (
            original.length !== items.length ||
            !original.every(
              (item, i) =>
                item.productId === items[i].productId &&
                item.quantity === items[i].quantity,
            )
          ) {
            throw new RpcException({
              code: status.ALREADY_EXISTS,
              message:
                'Reservation ID is already associated with different items',
            });
          }
          return { reservationId, reservedItems: original };
        }
        // Numeric order reduces deadlocks. The conditional UPDATE itself is the
        // protection against overselling; there is no read-check-write window.
        for (const item of items) {
          const [, affected] = await manager.query<StockUpdate>(
            `
          UPDATE inventory_stock
          SET available_quantity = available_quantity - $2
          WHERE product_id = $1 AND available_quantity >= $2
          RETURNING product_id`,
            [item.productId, item.quantity],
          );
          // This driver's UPDATE result is [returnedRows, affectedCount].
          if (affected !== 1) {
            const rows = await manager.query<{ product_id: string }[]>(
              'SELECT product_id FROM inventory_stock WHERE product_id = $1',
              [item.productId],
            );
            throw new RpcException({
              code: rows.length ? status.FAILED_PRECONDITION : status.NOT_FOUND,
              message: rows.length
                ? `Insufficient stock for product ${item.productId}`
                : `Inventory record for product ${item.productId} not found`,
            });
          }
          await manager.query(
            `
          INSERT INTO inventory_reservation_items (reservation_id, product_id, quantity)
          VALUES ($1, $2, $3)`,
            [reservationId, item.productId, item.quantity],
          );
        }
        return { reservationId, reservedItems: items };
      },
    );
    this.logger.log({
      event: 'inventory_reservation_confirmed',
      reservationId,
      itemCount: items.length,
    });
    return response;
  }

  async releaseStock(value: unknown): Promise<ReleaseStockResponse> {
    const reservationId = validate.reservationId(value);
    const response = await this.dataSource.transaction(
      'READ COMMITTED',
      async (manager) => {
        // An absent row cannot be protected by SELECT FOR UPDATE alone. Insert
        // a durable tombstone first; uniqueness coordinates both race orderings.
        await manager.query(
          `
        INSERT INTO inventory_reservations (reservation_id, status)
        VALUES ($1, 'CANCELLED') ON CONFLICT (reservation_id) DO NOTHING`,
          [reservationId],
        );
        const [reservation] = await manager.query<Reservation[]>(
          `
        SELECT status FROM inventory_reservations
        WHERE reservation_id = $1 FOR UPDATE`,
          [reservationId],
        );
        if (!reservation)
          throw new RpcException({
            code: status.INTERNAL,
            message: 'Reservation state is missing',
          });
        if (
          reservation.status === 'CANCELLED' ||
          reservation.status === 'RELEASED'
        )
          return { reservationId };
        const items = await manager.query<StockItem[]>(
          `
        SELECT product_id::text AS "productId", quantity
        FROM inventory_reservation_items WHERE reservation_id = $1
        ORDER BY product_id`,
          [reservationId],
        );
        if (!items.length)
          throw new RpcException({
            code: status.INTERNAL,
            message: 'Active reservation has no items',
          });
        for (const item of items) {
          const [, affected] = await manager.query<StockUpdate>(
            `
          UPDATE inventory_stock SET available_quantity = available_quantity + $2
          WHERE product_id = $1 RETURNING product_id`,
            [item.productId, item.quantity],
          );
          if (affected !== 1)
            throw new RpcException({
              code: status.INTERNAL,
              message: 'Failed to restore inventory stock',
            });
        }
        await manager.query(
          `UPDATE inventory_reservations SET status = 'RELEASED' WHERE reservation_id = $1`,
          [reservationId],
        );
        return { reservationId };
      },
    );
    this.logger.log({
      event: 'inventory_cancellation_recorded',
      reservationId,
    });
    return response;
  }
}
