import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Load `.env` from the working directory (the one ConfigModule reads) before
 * any module file runs decorators that read `process.env`.
 */
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  config({ path: envPath });
}
