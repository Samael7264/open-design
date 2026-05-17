import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SqliteDb = Database.Database;
type DbRow = Record<string, unknown>;
type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

const DEFAULT_AMR_GATEWAY_URL = 'http://127.0.0.1:8787';

export interface AmrCredentials {
  token: string;
  gateway: string;
  userId?: string;
  orgId?: string;
  projectId?: string;
  keyId?: string;
  createdAt: number;
  updatedAt: number;
}

function optionalCredentialFields(row: {
  userId: string | undefined;
  orgId: string | undefined;
  projectId: string | undefined;
  keyId: string | undefined;
}): Partial<AmrCredentials> {
  return {
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.keyId ? { keyId: row.keyId } : {}),
  };
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeGateway(value: unknown, env: RuntimeEnv): string {
  return (
    cleanString(value) ??
    cleanString(env.AMR_GATEWAY_URL) ??
    DEFAULT_AMR_GATEWAY_URL
  ).replace(/\/+$/, '');
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function amrSessionPath(env: RuntimeEnv = process.env): string {
  const configured = cleanString(env.AMR_SESSION);
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), '.amr', 'session.json');
}

export function readAmrSessionFile(env: RuntimeEnv = process.env): AmrCredentials | null {
  const file = amrSessionPath(env);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as DbRow;
  const token =
    cleanString(row.token) ??
    cleanString(row.api_key) ??
    cleanString(row.access_token);
  if (!token) return null;
  const now = Date.now();
  return {
    token,
    gateway: normalizeGateway(row.gateway, env),
    ...optionalCredentialFields({
      userId: cleanString(row.user_id),
      orgId: cleanString(row.org_id),
      projectId: cleanString(row.project_id),
      keyId: cleanString(row.key_id),
    }),
    createdAt: now,
    updatedAt: now,
  };
}

export function amrCredentialsFromCallback(
  input: Record<string, unknown>,
  env: RuntimeEnv = process.env,
): AmrCredentials | null {
  const token =
    cleanString(input.token) ??
    cleanString(input.access_token) ??
    cleanString(input.api_key);
  if (!token) return null;
  const now = Date.now();
  return {
    token,
    gateway: normalizeGateway(input.gateway, env),
    ...optionalCredentialFields({
      userId: cleanString(input.user_id ?? input.userId),
      orgId: cleanString(input.org_id ?? input.orgId),
      projectId: cleanString(input.project_id ?? input.projectId),
      keyId: cleanString(input.key_id ?? input.keyId),
    }),
    createdAt: now,
    updatedAt: now,
  };
}

export function getAmrCredentials(db: SqliteDb): AmrCredentials | null {
  const row = db.prepare(
    `SELECT token, gateway, user_id AS userId, org_id AS orgId,
            project_id AS projectId, key_id AS keyId,
            created_at AS createdAt, updated_at AS updatedAt
       FROM amr_credentials
      WHERE id = 1`,
  ).get() as DbRow | undefined;
  if (!row) return null;
  const token = cleanString(row.token);
  if (!token) return null;
  return {
    token,
    gateway: normalizeGateway(row.gateway, {}),
    ...optionalCredentialFields({
      userId: cleanString(row.userId),
      orgId: cleanString(row.orgId),
      projectId: cleanString(row.projectId),
      keyId: cleanString(row.keyId),
    }),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
  };
}

export function upsertAmrCredentials(db: SqliteDb, credentials: AmrCredentials): AmrCredentials {
  const now = Date.now();
  const createdAt = Number.isFinite(credentials.createdAt)
    ? credentials.createdAt
    : now;
  const updatedAt = now;
  db.prepare(
    `INSERT INTO amr_credentials
       (id, token, gateway, user_id, org_id, project_id, key_id, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       token = excluded.token,
       gateway = excluded.gateway,
       user_id = excluded.user_id,
       org_id = excluded.org_id,
       project_id = excluded.project_id,
       key_id = excluded.key_id,
       updated_at = excluded.updated_at`,
  ).run(
    credentials.token,
    normalizeGateway(credentials.gateway, {}),
    credentials.userId ?? null,
    credentials.orgId ?? null,
    credentials.projectId ?? null,
    credentials.keyId ?? null,
    createdAt,
    updatedAt,
  );
  return getAmrCredentials(db) as AmrCredentials;
}

export function clearAmrCredentials(db: SqliteDb): void {
  db.prepare(`DELETE FROM amr_credentials WHERE id = 1`).run();
}

export function amrCredentialsToEnv(credentials: AmrCredentials): Record<string, string> {
  return {
    AMR_TOKEN: credentials.token,
    // Current AMR CLI releases read AMR_API_KEY; AMR_TOKEN is kept for the
    // Open Design-facing contract and future AMR callback support.
    AMR_API_KEY: credentials.token,
    AMR_GATEWAY_URL: credentials.gateway,
  };
}
