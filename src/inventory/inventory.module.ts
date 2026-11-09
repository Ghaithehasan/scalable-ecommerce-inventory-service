import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER } from '@nestjs/core';

import { InventoryStockEntity } from './entities/inventory-stock.entity';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryExceptionFilter } from './inventory-exception.filter';

@Module({
  imports: [TypeOrmModule.forFeature([InventoryStockEntity])],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    { provide: APP_FILTER, useClass: InventoryExceptionFilter },
  ],
})
export class InventoryModule {}
