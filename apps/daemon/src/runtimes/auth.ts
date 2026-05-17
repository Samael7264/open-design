import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execAgentFile } from './invocation.js';
import type { RuntimeEnv } from './types.js';

export type AgentAuthProbeResult = {
  status: 'ok' | 'missing' | 'unknown';
  message?: string;
};

const CURSOR_AUTH_GUIDANCE =
  'Cursor Agent is not authenticated. Run `cursor-agent login`, then `cursor-agent status`, and retry. For automation, ensure CURSOR_API_KEY is set in the Open Design process environment.';
const AMR_AUTH_GUIDANCE =
  'AMR is not authenticated. Select AMR and retry so Open Design can launch `amr login --client-id open-design`, or run that command manually and retry.';

export function cursorAuthGuidance(): string {
  return CURSOR_AUTH_GUIDANCE;
}

export function amrAuthGuidance(): string {
  return AMR_AUTH_GUIDANCE;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function amrSessionPath(env: RuntimeEnv): string {
  const configured = cleanString((env as Record<string, unknown>).AMR_SESSION);
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), '.amr', 'session.json');
}

function hasAmrSessionToken(env: RuntimeEnv): boolean {
  const envRecord = env as Record<string, unknown>;
  if (cleanString(envRecord.AMR_TOKEN) || cleanString(envRecord.AMR_API_KEY)) {
    return true;
  }
  const file = amrSessionPath(env);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Boolean(
      cleanString(parsed.token) ||
      cleanString(parsed.api_key) ||
      cleanString(parsed.access_token),
    );
  } catch {
    return false;
  }
}

export function isCursorAuthFailureText(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  return (
    /authentication required/i.test(value) ||
    /not authenticated/i.test(value) ||
    /not logged in/i.test(value) ||
    /unauthenticated/i.test(value) ||
    /agent login/i.test(value) ||
    /cursor_api_key/i.test(value)
  );
}

export function isAmrAuthFailureText(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  return (
    /amr[_ -]?api[_ -]?key/i.test(value) ||
    /amr[_ -]?token/i.test(value) ||
    /run [`'"]?amr login/i.test(value) ||
    /no (api key|token|session)/i.test(value) ||
    /not authenticated/i.test(value) ||
    /not logged in/i.test(value) ||
    /unauthenticated/i.test(value) ||
    /\b401\b/.test(value) ||
    /unauthorized/i.test(value)
  );
}

export function isAmrSessionNotFoundText(text: string): boolean {
  const value = String(text || '');
  if (!value.trim()) return false;
  return (
    /session (not found|missing|expired)/i.test(value) ||
    /unknown session/i.test(value) ||
    /resume session .*not found/i.test(value) ||
    /cannot resume/i.test(value)
  );
}

export function classifyAgentAuthFailure(
  agentId: string,
  text: string,
): AgentAuthProbeResult | null {
  if (agentId === 'amr') {
    if (!isAmrAuthFailureText(text)) return null;
    return {
      status: 'missing',
      message: amrAuthGuidance(),
    };
  }
  if (agentId !== 'cursor-agent') return null;
  if (!isCursorAuthFailureText(text)) return null;
  return {
    status: 'missing',
    message: cursorAuthGuidance(),
  };
}

export async function probeAgentAuthStatus(
  agentId: string,
  resolvedBin: string,
  env: RuntimeEnv,
): Promise<AgentAuthProbeResult | null> {
  if (agentId === 'amr') {
    return hasAmrSessionToken(env)
      ? { status: 'ok' }
      : { status: 'missing', message: amrAuthGuidance() };
  }
  if (agentId !== 'cursor-agent') return null;
  try {
    const { stdout, stderr } = await execAgentFile(resolvedBin, ['status'], {
      env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${stdout ?? ''}\n${stderr ?? ''}`;
    if (isCursorAuthFailureText(output)) {
      return { status: 'missing', message: cursorAuthGuidance() };
    }
    return { status: 'ok' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: unknown;
      stderr?: unknown;
    };
    const output = [
      err.message,
      typeof err.stdout === 'string' ? err.stdout : '',
      typeof err.stderr === 'string' ? err.stderr : '',
    ].join('\n');
    if (isCursorAuthFailureText(output)) {
      return { status: 'missing', message: cursorAuthGuidance() };
    }
    return {
      status: 'unknown',
      message: 'Cursor Agent authentication status could not be verified with `cursor-agent status`.',
    };
  }
}
