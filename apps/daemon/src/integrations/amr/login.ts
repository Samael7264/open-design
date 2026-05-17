import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCommandInvocation } from '@open-design/platform';
import {
  getAmrCredentials,
  readAmrSessionFile,
  upsertAmrCredentials,
  type AmrCredentials,
} from './credentials.js';

type SqliteDb = Database.Database;
type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

const execFileAsync = promisify(execFile);

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeLoginError(error: unknown): string {
  const err = error as { message?: unknown; code?: unknown; signal?: unknown };
  const pieces = [
    typeof err?.message === 'string' ? err.message : String(error),
    err?.code != null ? `code=${String(err.code)}` : '',
    err?.signal != null ? `signal=${String(err.signal)}` : '',
  ].filter(Boolean);
  return pieces.join(' ');
}

async function cliSupportsLoginCallback(
  amrBin: string,
  env: RuntimeEnv,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(amrBin, ['login', '--help'], {
      env: env as NodeJS.ProcessEnv,
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    return String(stdout).includes('--callback');
  } catch {
    return false;
  }
}

export async function ensureAmrCredentials({
  db,
  amrBin,
  callbackUrl = 'open-design://amr-callback',
  env,
  timeoutMs = 180_000,
}: {
  db: SqliteDb;
  amrBin: string;
  callbackUrl?: string;
  env: RuntimeEnv;
  timeoutMs?: number;
}): Promise<AmrCredentials> {
  const persisted = getAmrCredentials(db);
  if (persisted) return persisted;

  const existingSession = readAmrSessionFile(env);
  if (existingSession) {
    return upsertAmrCredentials(db, existingSession);
  }

  const args = ['login', '--client-id', 'open-design'];
  if (await cliSupportsLoginCallback(amrBin, env)) {
    args.push('--callback', callbackUrl);
  }
  const gateway = cleanString(env.AMR_GATEWAY_URL);
  if (gateway) args.push('--gateway', gateway);
  const invocation = createCommandInvocation({
    command: amrBin,
    args,
    env: env as NodeJS.ProcessEnv,
  });
  try {
    await execFileAsync(invocation.command, invocation.args, {
      env: env as NodeJS.ProcessEnv,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  } catch (error) {
    throw new Error(
      `AMR OAuth login failed. Run \`amr login --client-id open-design\` and retry. ${safeLoginError(error)}`,
    );
  }

  const callbackCredentials = getAmrCredentials(db);
  if (callbackCredentials) return callbackCredentials;

  const freshSession = readAmrSessionFile(env);
  if (!freshSession) {
    throw new Error(
      'AMR login completed, but no session token was written. Run `amr login --client-id open-design` and retry.',
    );
  }
  return upsertAmrCredentials(db, freshSession);
}
