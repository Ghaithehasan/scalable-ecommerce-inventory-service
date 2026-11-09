
import {
  MigrationInterface,
  QueryRunner,
} from 'typeorm';

export class CreateInventoryTables1762700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {

    await queryRunner.query(`
      CREATE TABLE inventory_stock (
        product_id BIGINT PRIMARY KEY,
        available_quantity INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT stock_nonnegative
          CHECK (available_quantity >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_reservations (
        reservation_id VARCHAR(100) PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT reservation_status_valid
          CHECK (status IN ('RESERVED', 'RELEASED'))
      );
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_reservation_items (
        reservation_id VARCHAR(100) NOT NULL,
        product_id BIGINT NOT NULL,
        quantity INTEGER NOT NULL,

        PRIMARY KEY (reservation_id, product_id),

        CONSTRAINT reservation_fk
          FOREIGN KEY (reservation_id)
          REFERENCES inventory_reservations(reservation_id),

        CONSTRAINT stock_fk
          FOREIGN KEY (product_id)
          REFERENCES inventory_stock(product_id),

        CONSTRAINT quantity_positive
          CHECK (quantity > 0)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE inventory_reservation_items;`,
    );

    await queryRunner.query(
      `DROP TABLE inventory_reservations;`,
    );

    await queryRunner.query(
      `DROP TABLE inventory_stock;`,
    );
  }
}
