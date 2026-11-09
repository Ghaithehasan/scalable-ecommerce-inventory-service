import { status } from '@grpc/grpc-js';
import {
  ArgumentsHost,
  Catch,
  Logger,
  type RpcExceptionFilter,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { throwError } from 'rxjs';

@Catch()
export class InventoryExceptionFilter implements RpcExceptionFilter {
  private readonly logger = new Logger(InventoryExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const cause = error as {
      code?: string;
      driverError?: { code?: string };
    } | null;
    const rawCode = cause?.driverError?.code ?? cause?.code;
    const databaseCode = typeof rawCode === 'string' ? rawCode : undefined;
    let response: { code: number; message: string };
    if (error instanceof RpcException) {
      const rpc = error.getError();
      response =
        typeof rpc === 'object' && 'code' in rpc && typeof rpc.code === 'number'
          ? (rpc as { code: number; message: string })
          : { code: status.INTERNAL, message: 'Inventory operation failed' };
    } else if (
      databaseCode === '40P01' ||
      databaseCode === '40001' ||
      databaseCode === '55P03' ||
      databaseCode === '57014'
    ) {
      response = {
        code: status.ABORTED,
        message:
          'Inventory transaction could not complete; retry with the same reservation ID',
      };
    } else if (
      databaseCode?.startsWith('08') ||
      databaseCode === 'ECONNREFUSED' ||
      databaseCode === 'ECONNRESET' ||
      databaseCode === '57P01'
    ) {
      response = {
        code: status.UNAVAILABLE,
        message: 'Inventory database is unavailable',
      };
    } else {
      response = {
        code: status.INTERNAL,
        message: 'Inventory operation failed',
      };
    }
    const input = host.switchToRpc().getData<{ reservationId?: unknown }>();
    this.logger.warn({
      event: 'inventory_rpc_failed',
      reservationId:
        typeof input?.reservationId === 'string'
          ? input.reservationId.slice(0, 100)
          : undefined,
      grpcCode: response.code,
      databaseCode,
    });
    return throwError(() => response);
  }
}
