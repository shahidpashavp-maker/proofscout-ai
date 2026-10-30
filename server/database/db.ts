import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DatabaseHandle = Database.Database;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(moduleDirectory, '../../server/database/schema.sql');
const defaultDatabasePath = resolve(moduleDirectory, '../../data/proofscout.sqlite');

export function openDatabase(filePath = resolve(process.env.PROOFSCOUT_DB_PATH || defaultDatabasePath)): DatabaseHandle {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
  const connection = new Database(filePath);
  connection.pragma('foreign_keys = ON');
  try {
    connection.exec(readFileSync(schemaPath, 'utf8'));
  } catch (error) {
    connection.close();
    throw new Error(`Could not initialize the ProofScout database schema: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return connection;
}

export const db: DatabaseHandle = openDatabase();
