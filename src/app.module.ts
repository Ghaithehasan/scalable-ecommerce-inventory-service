import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryModule } from './inventory/inventory.module';
import { databaseOptions } from './database/database-options';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRootAsync({
      useFactory: () => databaseOptions(),
    }),

    InventoryModule,
  ],
})
export class AppModule {}
