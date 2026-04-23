import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
