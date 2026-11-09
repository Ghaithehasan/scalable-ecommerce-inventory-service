
import {
  Entity,
  PrimaryColumn,
  Column,
  Check,
} from 'typeorm';

@Entity('inventory_stock')
@Check('"available_quantity" >= 0')
export class InventoryStockEntity {
  @PrimaryColumn({
    name: 'product_id',
    type: 'bigint',
  })
  productId: string;

  @Column({
    name: 'available_quantity',
    type: 'integer',
    default: 0,
  })
  availableQuantity: number;
}
