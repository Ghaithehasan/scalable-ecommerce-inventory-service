import { status } from '@grpc/grpc-js';
import { deferred, inventoryHarness, type Harness } from './inventory-harness';

describe('Inventory gRPC with real PostgreSQL', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await inventoryHarness();
  }, 20000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.reset();
  });
  const items = [
    { productId: '10', quantity: 3 },
    { productId: '20', quantity: 2 },
  ];
  const reserve = (id: string, requested = items) =>
    h.call('ReserveStock', { reservationId: id, items: requested });
  const release = (id: string) => h.call('ReleaseStock', { reservationId: id });

  it('reads stock, preserving int64 IDs beyond JavaScript precision', async () => {
    expect(await h.call('GetStock', { productId: '9007199254740993' })).toEqual(
      { productId: '9007199254740993', availableQuantity: 7 },
    );
  });
  it('adds a batch query without changing single-product GetStock', async () => {
    expect(
      await h.call('GetStocks', { productIds: ['10', '20', '999'] }),
    ).toEqual({
      items: [
        { productId: '10', availableQuantity: 10 },
        { productId: '20', availableQuantity: 10 },
      ],
    });
  });
  it('deducts every item and persists one reservation', async () => {
    expect(await reserve('success')).toMatchObject({
      reservationId: 'success',
      reservedItems: items,
    });
    expect(await h.quantity('10')).toBe(7);
    expect(await h.quantity('20')).toBe(8);
  });
  it('leaves nothing behind when stock is insufficient', async () => {
    await expect(
      reserve('short', [{ productId: '10', quantity: 11 }]),
    ).rejects.toMatchObject({ code: status.FAILED_PRECONDITION });
    expect(await h.quantity('10')).toBe(10);
    expect(
      await h.db.query('SELECT * FROM inventory_reservations'),
    ).toHaveLength(0);
  });
  it('rolls back earlier deductions if a later product is short or missing', async () => {
    for (const item of [
      { productId: '20', quantity: 11 },
      { productId: '30', quantity: 1 },
    ]) {
      await expect(
        reserve(`rollback-${item.productId}`, [items[0], item]),
      ).rejects.toMatchObject({
        code:
          item.productId === '30'
            ? status.NOT_FOUND
            : status.FAILED_PRECONDITION,
      });
      expect(await h.quantity('10')).toBe(10);
    }
    expect(
      await h.db.query('SELECT * FROM inventory_reservation_items'),
    ).toHaveLength(0);
  });
  it('replays normalized/reordered items without deducting twice', async () => {
    await reserve('same');
    await reserve('same', [...items].reverse());
    await h.service.reserveStock({
      reservationId: 'same',
      items: [{ productId: '0010', quantity: 3 }, items[1]],
    });
    expect(await h.quantity('10')).toBe(7);
  });
  it('rejects reuse of an active reservation ID with a changed payload', async () => {
    await reserve('conflict');
    await expect(
      reserve('conflict', [{ productId: '10', quantity: 1 }]),
    ).rejects.toMatchObject({ code: status.ALREADY_EXISTS });
    expect(await h.quantity('10')).toBe(7);
  });
  it('coordinates 20 concurrent identical reservations using database uniqueness', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => reserve('concurrent-same')),
    );
    expect(await h.quantity('10')).toBe(7);
    expect(
      await h.db.query('SELECT * FROM inventory_reservations'),
    ).toHaveLength(1);
  });
  it('allows exactly one of 20 requests to reserve the final item', async () => {
    await h.db.query(
      'UPDATE inventory_stock SET available_quantity = 1 WHERE product_id = 10',
    );
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserve(`last-${i}`, [{ productId: '10', quantity: 1 }]),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await h.quantity('10')).toBe(0);
  });
  it('never oversells under overlapping reversed multi-product requests', async () => {
    const pair = [
      { productId: '10', quantity: 1 },
      { productId: '20', quantity: 1 },
    ];
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) =>
        reserve(`multi-${i}`, i % 2 ? [...pair].reverse() : pair),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(10);
    expect(await h.quantity('10')).toBe(0);
    expect(await h.quantity('20')).toBe(0);
  });
  it('restores quantities once across repeated and simultaneous releases', async () => {
    await reserve('release');
    await Promise.all(Array.from({ length: 20 }, () => release('release')));
    await release('release');
    expect(await h.quantity('10')).toBe(10);
    expect(await h.quantity('20')).toBe(10);
    await expect(reserve('release')).rejects.toMatchObject({
      code: status.FAILED_PRECONDITION,
    });
  });
  it('records a durable tombstone before a delayed reserve', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => release('early-cancel')),
    );
    await expect(reserve('early-cancel')).rejects.toMatchObject({
      code: status.FAILED_PRECONDITION,
    });
    expect(await h.quantity('10')).toBe(10);
    const [row] = await h.db.query(
      'SELECT status FROM inventory_reservations WHERE reservation_id = $1',
      ['early-cancel'],
    );
    expect(row.status).toBe('CANCELLED');
  });
  it('handles an in-flight reserve while release waits on its uncommitted identity', async () => {
    const blocker = h.db.createQueryRunner();
    await blocker.startTransaction();
    await blocker.query(
      'SELECT * FROM inventory_stock WHERE product_id = 10 FOR UPDATE',
    );
    const pending = reserve('reserve-first');
    // Observe the actual blocked UPDATE in PostgreSQL, not a timing guess.
    await vi.waitFor(async () => {
      const rows = await h.db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SET available_quantity = available_quantity -%'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });
    const cancelling = release('reserve-first');
    await blocker.commitTransaction();
    await blocker.release();
    await Promise.all([pending, cancelling]);
    expect(await h.quantity('10')).toBe(10);
  });
  it('handles cancellation holding the identity before reserve starts', async () => {
    const blocker = h.db.createQueryRunner();
    await blocker.startTransaction();
    await blocker.query(
      `INSERT INTO inventory_reservations (reservation_id, status) VALUES ('cancel-first', 'CANCELLED')`,
    );
    const pending = reserve('cancel-first');
    await blocker.commitTransaction();
    await blocker.release();
    await expect(pending).rejects.toMatchObject({
      code: status.FAILED_PRECONDITION,
    });
    expect(await h.quantity('10')).toBe(10);
  });
  it('converges to the initial stock in 15 concurrent reserve/release races', async () => {
    await h.db.query(
      'UPDATE inventory_stock SET available_quantity = 100 WHERE product_id = 10',
    );
    for (let i = 0; i < 15; i++) {
      const results = await Promise.allSettled([
        reserve(`race-${i}`, [{ productId: '10', quantity: 1 }]),
        release(`race-${i}`),
      ]);
      expect(results[1].status).toBe('fulfilled');
    }
    expect(await h.quantity('10')).toBe(100);
  });
  it('allows compensation after the caller times out following a committed reservation', async () => {
    const committed = deferred(),
      reply = deferred();
    const original = h.service.reserveStock.bind(h.service);
    const spy = vi
      .spyOn(h.service, 'reserveStock')
      .mockImplementation(async (request) => {
        const response = await original(request);
        committed.resolve();
        await reply.promise;
        return response;
      });
    try {
      const result = h
        .call('ReserveStock', { reservationId: 'timeout', items }, 150)
        .catch((error) => error);
      await committed.promise;
      expect(await h.quantity('10')).toBe(7);
      expect(await result).toMatchObject({ code: status.DEADLINE_EXCEEDED });
      await release('timeout');
      expect(await h.quantity('10')).toBe(10);
    } finally {
      reply.resolve();
      spy.mockRestore();
    }
  });
  it.each([
    ['GetStock', {}, status.INVALID_ARGUMENT],
    ['GetStock', { productId: '-1' }, status.INVALID_ARGUMENT],
    ['GetStock', { productId: '999' }, status.NOT_FOUND],
    ['ReserveStock', { items }, status.INVALID_ARGUMENT],
    [
      'ReserveStock',
      { reservationId: 'empty', items: [] },
      status.INVALID_ARGUMENT,
    ],
    [
      'ReserveStock',
      { reservationId: 'dup', items: [items[0], items[0]] },
      status.INVALID_ARGUMENT,
    ],
    [
      'ReserveStock',
      { reservationId: 'zero', items: [{ productId: '10', quantity: 0 }] },
      status.INVALID_ARGUMENT,
    ],
    [
      'ReserveStock',
      { reservationId: 'negative', items: [{ productId: '10', quantity: -1 }] },
      status.INVALID_ARGUMENT,
    ],
    ['ReleaseStock', {}, status.INVALID_ARGUMENT],
  ])(
    'returns the correct status for invalid %s input %#',
    async (method, request, code) => {
      await expect(h.call(method, request)).rejects.toMatchObject({ code });
    },
  );
  it('rejects malformed direct calls and int64 overflow at runtime', async () => {
    for (const value of ['9223372036854775808', 10, null, 'abc']) {
      const error = await h.service.getStock(value).then(
        () => undefined,
        (exception) => exception.getError(),
      );
      expect(error).toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    await expect(
      h.service.reserveStock({ reservationId: 'bad', items: [null] } as any),
    ).rejects.toBeDefined();
  });
  it('keeps tombstones effective when the cancellation migration is reverted', async () => {
    await release('migration-tombstone');
    await h.db.undoLastMigration();
    try {
      const [row] = await h.db.query(
        'SELECT status FROM inventory_reservations WHERE reservation_id = $1',
        ['migration-tombstone'],
      );
      expect(row.status).toBe('RELEASED');
      await expect(reserve('migration-tombstone')).rejects.toMatchObject({
        code: status.FAILED_PRECONDITION,
      });
      expect(await h.quantity('10')).toBe(10);
    } finally {
      await h.db.runMigrations();
    }
  });
  it('enforces stock, item, uniqueness and foreign-key constraints in PostgreSQL', async () => {
    await expect(
      h.db.query(
        'UPDATE inventory_stock SET available_quantity = -1 WHERE product_id = 10',
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await reserve('constraints');
    await expect(
      h.db.query(
        `INSERT INTO inventory_reservation_items VALUES ('constraints', 10, 1)`,
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    await expect(
      h.db.query(
        `INSERT INTO inventory_reservation_items VALUES ('constraints', 20, 0)`,
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      h.db.query(
        `INSERT INTO inventory_reservation_items VALUES ('missing', 20, 1)`,
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });
});
