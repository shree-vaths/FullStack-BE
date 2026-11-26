import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * All runtime configuration lives here, read once from the environment with
 * sensible local defaults. Nothing else in the codebase reads process.env.
 *
 * Locally, values come from server/.env. On a host (e.g. Render) set them as
 * environment variables instead; real environment variables always win over
 * the file.
 */

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(serverRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: "${value}"`);
  }
  return port;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to server/.env or to the host's environment variables.`,
    );
  }
  return value;
}

export const config = {
  port: parsePort(process.env.PORT, 3001),
  /** Postgres connection string, e.g. the Supabase "Session pooler" URL. */
  databaseUrl: requireEnv('DATABASE_URL'),
  /**
   * TLS to the database. On by default (Supabase requires it); set
   * DATABASE_SSL=disable only for a local Postgres without TLS.
   */
  databaseSsl: process.env.DATABASE_SSL !== 'disable',
} as const;
