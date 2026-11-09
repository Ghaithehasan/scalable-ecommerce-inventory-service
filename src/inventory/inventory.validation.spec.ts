import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import * as validate from './inventory.validation';

function invalid(operation: () => unknown): void {
  try {
    operation();
    throw new Error('Expected INVALID_ARGUMENT');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
  }
}
describe('Inventory runtime validation', () => {
  it('canonicalizes IDs without losing int64 precision', () => {
    expect(validate.productId('0010')).toBe('10');
    expect(validate.productId('9223372036854775807')).toBe(
      '9223372036854775807',
    );
  });
  it.each([
    undefined,
    null,
    10,
    '',
    '-1',
    '0',
    '1.5',
    'abc',
    '9223372036854775808',
  ])('rejects invalid product ID %s', (value) =>
    invalid(() => validate.productId(value)),
  );
  it.each([undefined, '', '   ', 'r'.repeat(101)])(
    'rejects invalid reservation ID %#',
    (value) => invalid(() => validate.reservationId(value)),
  );
  it.each([0, -1, 1.5, 2147483648, NaN, '1'])(
    'rejects invalid quantity %s',
    (quantity) =>
      invalid(() => validate.stockItems([{ productId: '10', quantity }])),
  );
  it('rejects malformed items and duplicates after normalization', () => {
    invalid(() => validate.stockItems([null]));
    invalid(() => validate.stockItems([]));
    invalid(() =>
      validate.stockItems([
        { productId: '0010', quantity: 1 },
        { productId: '10', quantity: 2 },
      ]),
    );
  });
  it('uses numeric rather than lexical product ordering', () => {
    expect(
      validate
        .stockItems([
          { productId: '10', quantity: 1 },
          { productId: '2', quantity: 1 },
        ])
        .map((item) => item.productId),
    ).toEqual(['2', '10']);
  });
});
