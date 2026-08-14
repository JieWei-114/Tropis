import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

/** Load `.env` before any module file runs decorators that read `process.env`. */
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  config({ path: envPath });
}
