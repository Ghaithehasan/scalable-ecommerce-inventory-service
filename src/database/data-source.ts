import 'dotenv/config';

import { DataSource } from 'typeorm';
import { join } from 'node:path';

import { databaseOptions } from './database-options';

export default new DataSource({
  ...databaseOptions(),

  migrations: [join(__dirname, 'migrations', '*{.ts,.js}')],

  synchronize: false,
});
