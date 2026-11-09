import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import request from 'supertest';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  deferred,
  freePort,
  inventoryHarness,
  testUrl,
  type Harness,
} from './inventory-harness';

const mainRoot = resolve(process.env.MAIN_API_DIR ?? '../e-commerce');
const main = createRequire(resolve(mainRoot, 'package.json'));
const load = (path: string) => main(resolve(mainRoot, 'dist', path));
const common = main('@nestjs/common');
const { Test } = main('@nestjs/testing');
const { APP_GUARD } = main('@nestjs/core');
const { ConfigModule, ConfigService } = main('@nestjs/config');
const { TypeOrmModule } = main('@nestjs/typeorm');
const { DataSource } = main('typeorm');
const { ProductsModule } = load('products/products.module');
const { OrdersModule } = load('orders/orders.module');
const { OrdersService } = load('orders/orders.service');
const { RolesGuard } = load('auth/guards/roles.guard');
const { AllExceptionsFilter } = load('common/filters/http-exception.filter');
const { InventoryClient } = load('inventory/inventory.client');
const { InventoryOperationsService } = load(
  'inventory/inventory-operations.service',
);
const entities = [
  load('users/entities/user.entity').UserEntity,
  load('products/entities/product.entity').ProductEntity,
  load('products/entities/category.entity').CategoryEntity,
  load('products/entities/product-image.entity').ProductImageEntity,
  load('orders/entities/order.entity').OrderEntity,
  load('orders/entities/order-item.entity').OrderItemEntity,
];
const migrations = [
  load('migrations/1793744493449-InitialSchema').InitialSchema1793744493449,
  load('migrations/1794268800000-AddInventoryOrderOperations')
    .AddInventoryOrderOperations1794268800000,
];

describe('Main HTTP API -> real gRPC -> independent PostgreSQL databases', () => {
  let h: Harness,
    app: any,
    db: any,
    config: any,
    operations: any,
    inventory: any,
    orders: any;
  let actingUser: { id: number; role: string };
  const basket = {
    items: [
      { productId: 1, quantity: 3 },
      { productId: 2, quantity: 2 },
    ],
  };
  const post = (key: string, body = basket) =>
    request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(body);
  const op = async (id: string) =>
    (
      await db.query('SELECT * FROM inventory_order_operations WHERE id = $1', [
        id,
      ])
    )[0];
  const pendingOp = async () =>
    (await db.query('SELECT * FROM inventory_order_operations'))[0];
  const freshWorker = () =>
    new InventoryOperationsService(db, inventory, config);

  beforeAll(async () => {
    h = await inventoryHarness();
    common.Logger.overrideLogger(false);
    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              INVENTORY_GRPC_URL: h.address,
              INVENTORY_COMPENSATION_INTERVAL_MS: 0,
              INVENTORY_COMPENSATION_RETRY_MS: 100,
              INVENTORY_RESERVE_TIMEOUT_MS: 1000,
              INVENTORY_RELEASE_TIMEOUT_MS: 1000,
            }),
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: testUrl('TEST_MAIN_DATABASE_URL', 'ecommerce_test'),
          entities,
          migrations,
          migrationsRun: true,
          synchronize: false,
          extra: { max: 20, statement_timeout: 10000, lock_timeout: 5000 },
        }),
        ProductsModule,
        OrdersModule,
      ],
      providers: [
        {
          provide: APP_GUARD,
          useValue: {
            canActivate(context: any) {
              context.switchToHttp().getRequest().user = actingUser;
              return true;
            },
          },
        },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = fixture.createNestApplication();
    app.useGlobalPipes(
      new common.ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    db = app.get(DataSource);
    config = app.get(ConfigService);
    operations = app.get(InventoryOperationsService);
    inventory = app.get(InventoryClient);
    orders = app.get(OrdersService);
  }, 20000);
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    actingUser = { id: 1, role: 'CUSTOMER' };
    config.set('INVENTORY_RESERVE_TIMEOUT_MS', 1000);
    await h.reset();
    await h.db.query(
      'INSERT INTO inventory_stock(product_id, available_quantity) VALUES (1, 10), (2, 10)',
    );
    // Guarded by testUrl: this is the runner's dedicated ecommerce_test DB.
    await db.query(
      'TRUNCATE inventory_order_operations, order_items, orders, product_images, products, categories, users RESTART IDENTITY CASCADE',
    );
    await db.query(
      `INSERT INTO users(name,email,gender,"passwordHash",role) VALUES ('Customer','customer@example.test','MALE','test-only','CUSTOMER'), ('Other','other@example.test','FEMALE','test-only','CUSTOMER'), ('Manager','manager@example.test','MALE','test-only','RESPONSIBLE')`,
    );
    await db.query(`INSERT INTO categories(name,slug) VALUES ('Test','test')`);
    await db.query(
      `INSERT INTO products(name,price,category_id) VALUES ('First',125,1), ('Second',19.99,1)`,
    );
  });

  it('returns authoritative stock in product details and product pages', async () => {
    const one = await request(app.getHttpServer())
      .get('/products/1')
      .expect(200);
    expect(one.body).toMatchObject({
      id: 1,
      availableQuantity: 10,
      price: 125,
    });
    const page = await request(app.getHttpServer())
      .get('/products')
      .expect(200);
    expect(
      page.body.data.map((product: any) => product.availableQuantity),
    ).toEqual([10, 10]);
  });
  it('builds Swagger schemas from compiled modules under a Unicode project path', () => {
    const swagger = main('@nestjs/swagger');
    const document = swagger.SwaggerModule.createDocument(
      app,
      new swagger.DocumentBuilder().setTitle('Test').setVersion('1').build(),
      {
        extraModels: [
          load('auth/dto/auth-response.dto').AuthResponseDto,
          load('users/dto/user-response.dto').UserResponseDto,
        ],
      },
    );
    expect(document.paths['/orders']).toBeDefined();
    expect(
      document.components.schemas.ProductResponseDto.properties
        .availableQuantity,
    ).toBeDefined();
  });
  it('keeps the catalogue available with unknown quantities when Inventory is down', async () => {
    const spy = vi.spyOn(h.service, 'getStocks').mockRejectedValue(
      new RpcException({
        code: status.UNAVAILABLE,
        message: 'simulated unavailable read',
      }),
    );
    try {
      const response = await request(app.getHttpServer())
        .get('/products/1')
        .expect(200);
      expect(response.body.availableQuantity).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('saves an order and price snapshots after reserving all items', async () => {
    const response = await post('create').expect(201);
    expect(response.body.totalAmount).toBe(414.98);
    expect(response.body.items.map((item: any) => item.unitPrice)).toEqual([
      125, 19.99,
    ]);
    expect(await h.quantity('1')).toBe(7);
    expect(await h.quantity('2')).toBe(8);
    expect((await op(response.body.inventoryReservationId)).status).toBe(
      'COMPLETED',
    );
    await db.query('UPDATE products SET price = 999 WHERE id = 1');
    const reloaded = await request(app.getHttpServer())
      .get(`/orders/${response.body.id}`)
      .expect(200);
    expect(reloaded.body.items[0].unitPrice).toBe(125);
  });
  it('replays an HTTP idempotency key without duplicate orders or deductions', async () => {
    const first = await post('retry').expect(201);
    const again = await post('retry', {
      items: [...basket.items].reverse(),
    }).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await db.query('SELECT id FROM orders')).toHaveLength(1);
    expect(await h.quantity('1')).toBe(7);
    await post('retry', { items: [{ productId: 1, quantity: 1 }] }).expect(409);
  });
  it('coordinates concurrent HTTP retries of the same logical order', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post('parallel')),
    );
    expect(results.every((result) => [201, 409].includes(result.status))).toBe(
      true,
    );
    expect(results.some((result) => result.status === 201)).toBe(true);
    expect(await db.query('SELECT id FROM orders')).toHaveLength(1);
    expect(await h.quantity('1')).toBe(7);
  });
  it('maps insufficient stock to 409 and leaves no partial local order', async () => {
    await h.db.query(
      'UPDATE inventory_stock SET available_quantity = 0 WHERE product_id = 2',
    );
    await post('shortage').expect(409);
    expect(await db.query('SELECT id FROM orders')).toHaveLength(0);
    expect(await h.quantity('1')).toBe(10);
  });
  it('maps a missing inventory record to 404 while displaying unknown stock as null', async () => {
    await h.db.query('DELETE FROM inventory_stock WHERE product_id = 1');
    const product = await request(app.getHttpServer())
      .get('/products/1')
      .expect(200);
    expect(product.body.availableQuantity).toBeNull();
    await post('missing').expect(404);
  });

  async function failOrderInserts() {
    await db.query(
      `CREATE FUNCTION fail_test_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated order persistence failure'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER fail_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION fail_test_order()',
    );
  }
  async function restoreOrderInserts() {
    await db.query('DROP TRIGGER IF EXISTS fail_order ON orders');
    await db.query('DROP FUNCTION IF EXISTS fail_test_order()');
  }
  it('compensates a real PostgreSQL order-save failure after reservation', async () => {
    await failOrderInserts();
    try {
      await post('save-fails').expect(500);
      expect(await h.quantity('1')).toBe(10);
      expect(await h.quantity('2')).toBe(10);
      expect(await db.query('SELECT id FROM orders')).toHaveLength(0);
      expect((await pendingOp()).status).toBe('CANCELLED');
    } finally {
      await restoreOrderInserts();
    }
  });
  it('persists failed compensation and completes it using a fresh worker', async () => {
    await failOrderInserts();
    const unavailable = vi.spyOn(h.service, 'releaseStock').mockRejectedValue(
      new RpcException({
        code: status.UNAVAILABLE,
        message: 'simulated unavailable Inventory',
      }),
    );
    try {
      await post('compensation-fails').expect(500);
      const operation = await pendingOp();
      expect(operation.status).toBe('CANCEL_PENDING');
      expect(await h.quantity('1')).toBe(7);
      unavailable.mockRestore();
      await db.query(
        "UPDATE inventory_order_operations SET next_attempt_at = now() - interval '1 second'",
      );
      await Promise.all([freshWorker().runOnce(), freshWorker().runOnce()]);
      expect((await op(operation.id)).status).toBe('CANCELLED');
      expect(await h.quantity('1')).toBe(10);
      await freshWorker().runOnce();
      expect(await h.quantity('1')).toBe(10);
    } finally {
      unavailable.mockRestore();
      await restoreOrderInserts();
    }
  });
  it('compensates a deadline after inventory has actually committed', async () => {
    config.set('INVENTORY_RESERVE_TIMEOUT_MS', 150);
    const committed = deferred(),
      reply = deferred();
    const original = h.service.reserveStock.bind(h.service);
    const slow = vi
      .spyOn(h.service, 'reserveStock')
      .mockImplementation(async (input) => {
        const response = await original(input);
        committed.resolve();
        await reply.promise;
        return response;
      });
    try {
      const pending = post('unknown-outcome').then((response) => response);
      await committed.promise;
      expect(await h.quantity('1')).toBe(7);
      expect((await pending).status).toBe(503);
      expect(await h.quantity('1')).toBe(10);
      expect((await pendingOp()).status).toBe('CANCELLED');
      expect(await db.query('SELECT id FROM orders')).toHaveLength(0);
      await post('unknown-outcome').expect(409);
    } finally {
      reply.resolve();
      slow.mockRestore();
    }
  });
  it('handles an unreachable Inventory with a bounded deadline and no order', async () => {
    const offline = new InventoryClient(
      new ConfigService({
        INVENTORY_GRPC_URL: `127.0.0.1:${await freePort()}`,
        INVENTORY_RESERVE_TIMEOUT_MS: 200,
      }),
    );
    offline.onModuleInit();
    const spy = vi
      .spyOn(inventory, 'reserveStock')
      .mockImplementation((...args: any[]) => offline.reserveStock(...args));
    try {
      await post('offline').expect(503);
      expect(await db.query('SELECT id FROM orders')).toHaveLength(0);
      expect(await h.quantity('1')).toBe(10);
    } finally {
      spy.mockRestore();
      offline.onModuleDestroy();
    }
  });
  it('recovers a process crash after reserve and fences the stale order writer', async () => {
    const items = [{ productId: 1, quantity: 3, unitPrice: 125 }];
    const { operation } = await operations.begin(
      1,
      'crash',
      operations.fingerprint(items),
      items,
      375,
    );
    await h.call('ReserveStock', {
      reservationId: operation.id,
      items: [{ productId: '1', quantity: 3 }],
    });
    await db.query(
      "UPDATE inventory_order_operations SET expires_at = now() - interval '1 second'",
    );
    await freshWorker().runOnce();
    expect((await op(operation.id)).status).toBe('CANCELLED');
    expect(await h.quantity('1')).toBe(10);
    await expect(orders.writeOrder(operation)).rejects.toBeInstanceOf(
      common.ConflictException,
    );
    expect(await db.query('SELECT id FROM orders')).toHaveLength(0);
  });
  it('never compensates an operation whose local COMMIT succeeded', async () => {
    const response = await post('lost-commit-reply').expect(201);
    await operations.cancelPendingCreation(
      response.body.inventoryReservationId,
    );
    expect((await op(response.body.inventoryReservationId)).status).toBe(
      'COMPLETED',
    );
    expect(await h.quantity('1')).toBe(7);
  });
  it('lets a committing local order win against concurrent stale-operation recovery', async () => {
    const items = [{ productId: 1, quantity: 3, unitPrice: 125 }];
    const { operation } = await operations.begin(
      1,
      'commit-race',
      operations.fingerprint(items),
      items,
      375,
    );
    await h.call('ReserveStock', {
      reservationId: operation.id,
      items: [{ productId: '1', quantity: 3 }],
    });
    await db.query(
      "UPDATE inventory_order_operations SET expires_at = now() - interval '1 second'",
    );
    await db.query(
      `CREATE FUNCTION wait_test_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(735192); RETURN NEW; END $$`,
    );
    await db.query(
      'CREATE TRIGGER wait_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION wait_test_order()',
    );
    const blocker = db.createQueryRunner();
    let writing: Promise<number> | undefined,
      recovery: Promise<void> | undefined;
    try {
      await blocker.startTransaction();
      await blocker.query('SELECT pg_advisory_xact_lock(735192)');
      writing = orders.writeOrder(operation);
      void writing!.catch(() => {});
      await vi.waitFor(async () => {
        const blocked = await db.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO "orders"%'`,
        );
        expect(blocked.length).toBeGreaterThan(0);
      });
      recovery = freshWorker().runOnce();
      void recovery!.catch(() => {});
      await blocker.commitTransaction();
      await writing;
      await recovery;
      expect((await op(operation.id)).status).toBe('COMPLETED');
      expect(await h.quantity('1')).toBe(7);
      expect(await db.query('SELECT id FROM orders')).toHaveLength(1);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await Promise.allSettled([writing, recovery]);
      await db.query('DROP TRIGGER IF EXISTS wait_order ON orders');
      await db.query('DROP FUNCTION IF EXISTS wait_test_order()');
    }
  });
  it('queues cancellation with the local status change and restores stock once', async () => {
    const response = await post('cancel-order').expect(201);
    actingUser = { id: 3, role: 'RESPONSIBLE' };
    await request(app.getHttpServer())
      .patch(`/orders/${response.body.id}/status`)
      .send({ status: 'CANCELLED' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/orders/${response.body.id}/status`)
      .send({ status: 'CANCELLED' })
      .expect(200);
    expect(await h.quantity('1')).toBe(10);
    expect((await op(response.body.inventoryReservationId)).status).toBe(
      'CANCELLED',
    );
  });
  it('restores a deleted pending order but keeps a delivered sale deducted', async () => {
    const pending = await post('delete-pending').expect(201);
    actingUser = { id: 3, role: 'RESPONSIBLE' };
    await request(app.getHttpServer())
      .delete(`/orders/${pending.body.id}`)
      .expect(204);
    expect(await h.quantity('1')).toBe(10);
    actingUser = { id: 1, role: 'CUSTOMER' };
    const sold = await post('delivered').expect(201);
    actingUser = { id: 3, role: 'RESPONSIBLE' };
    for (const state of ['CONFIRMED', 'SHIPPED', 'DELIVERED'])
      await request(app.getHttpServer())
        .patch(`/orders/${sold.body.id}/status`)
        .send({ status: state })
        .expect(200);
    await request(app.getHttpServer())
      .delete(`/orders/${sold.body.id}`)
      .expect(204);
    expect(await h.quantity('1')).toBe(7);
    expect((await op(sold.body.inventoryReservationId)).order_id).toBeNull();
  });
  it('preserves order ownership and responsible-only operations', async () => {
    const response = await post('ownership').expect(201);
    await request(app.getHttpServer())
      .delete(`/orders/${response.body.id}`)
      .expect(403);
    actingUser = { id: 2, role: 'CUSTOMER' };
    await request(app.getHttpServer())
      .get(`/orders/${response.body.id}`)
      .expect(403);
  });
});
