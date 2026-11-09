import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCancellationState1794268800001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE inventory_reservations DROP CONSTRAINT reservation_status_valid`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory_reservations ADD CONSTRAINT reservation_status_valid CHECK (status IN ('RESERVED', 'RELEASED', 'CANCELLED'))`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Preserve cancellation markers when reverting to the previous two states.
    await queryRunner.query(
      `UPDATE inventory_reservations SET status = 'RELEASED' WHERE status = 'CANCELLED'`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory_reservations DROP CONSTRAINT reservation_status_valid`,
    );
    await queryRunner.query(
      `ALTER TABLE inventory_reservations ADD CONSTRAINT reservation_status_valid CHECK (status IN ('RESERVED', 'RELEASED'))`,
    );
  }
}
