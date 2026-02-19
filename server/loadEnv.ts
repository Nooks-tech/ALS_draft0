/**
 * Load .env before any other module reads process.env
 */
import path from 'path';
import dotenv from 'dotenv';

// __dirname = server/ when this file is server/loadEnv.ts
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'server', '.env') });
