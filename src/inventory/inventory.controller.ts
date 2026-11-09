import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { InventoryService } from './inventory.service';
import type {
  GetStockRequest,
  GetStocksRequest,
  ReleaseStockRequest,
  ReserveStockRequest,
} from './inventory.types';

@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}
  @GrpcMethod('InventoryService', 'GetStock')
  getStock(request: GetStockRequest) {
    return this.inventoryService.getStock(request?.productId);
  }
  @GrpcMethod('InventoryService', 'GetStocks')
  getStocks(request: GetStocksRequest) {
    return this.inventoryService.getStocks(request?.productIds ?? []);
  }
  @GrpcMethod('InventoryService', 'ReserveStock')
  reserveStock(request: ReserveStockRequest) {
    return this.inventoryService.reserveStock(request);
  }
  @GrpcMethod('InventoryService', 'ReleaseStock')
  releaseStock(request: ReleaseStockRequest) {
    return this.inventoryService.releaseStock(request?.reservationId);
  }
}
