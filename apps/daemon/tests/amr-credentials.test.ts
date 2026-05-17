import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';

import {
  amrCredentialsFromCallback,
  amrCredentialsToEnv,
  clearAmrCredentials,
  getAmrCredentials,
  readAmrSessionFile,
  upsertAmrCredentials,
} from '../src/integrations/amr/credentials.js';
import { ensureOpenDesignAmrAgent } from '../src/integrations/amr/agents.js';
import { closeDatabase, openDatabase } from '../src/db.js';

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes AMR OAuth callback credentials', () => {
  const credentials = amrCredentialsFromCallback({
    token: 'callback-token',
    gateway: 'https://gateway.example.com/',
    user_id: 'user-1',
    org_id: 'org-1',
    project_id: 'project-1',
    key_id: 'key-1',
  });

  assert.equal(credentials?.token, 'callback-token');
  assert.equal(credentials?.gateway, 'https://gateway.example.com');
  assert.equal(credentials?.userId, 'user-1');
  assert.equal(credentials?.orgId, 'org-1');
  assert.equal(credentials?.projectId, 'project-1');
  assert.equal(credentials?.keyId, 'key-1');
});

test('creates a default AMR agent when the gateway list is empty', async () => {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      url,
      auth: headers.get('authorization'),
      ...(body ? { body } : {}),
    });
    if (url.endsWith('/v1/agents') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        id: 'agent-1',
        name: 'open-design-default',
        base: 'claude-code',
        model: 'auto',
      }),
      { status: 200 },
    );
  };

  const agent = await ensureOpenDesignAmrAgent(
    {
      token: 'token-1',
      gateway: 'https://gateway.example.com',
      createdAt: 1,
      updatedAt: 1,
    },
    fetchImpl,
  );

  assert.equal(agent.id, 'agent-1');
  assert.deepEqual(calls, [
    {
      method: 'GET',
      url: 'https://gateway.example.com/v1/agents',
      auth: 'Bearer token-1',
    },
    {
      method: 'POST',
      url: 'https://gateway.example.com/v1/agents',
      auth: 'Bearer token-1',
      body: {
        name: 'open-design-default',
        base: 'claude-code',
        model: 'auto',
        system: "You are open-design's helper agent.",
        tools: [],
      },
    },
  ]);
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test('reads current AMR session file shape and normalizes env for CLI runs', () => {
  const dir = tempDir('od-amr-session-');
  const sessionPath = path.join(dir, 'session.json');
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({
      gateway: 'http://127.0.0.1:8787/',
      api_key: 'amr-token',
      user_id: 'user-1',
      org_id: 'org-1',
      project_id: 'project-1',
      key_id: 'key-1',
    }),
    'utf8',
  );

  const credentials = readAmrSessionFile({ AMR_SESSION: sessionPath });

  assert.equal(credentials?.token, 'amr-token');
  assert.equal(credentials?.gateway, 'http://127.0.0.1:8787');
  assert.equal(credentials?.userId, 'user-1');
  assert.deepEqual(amrCredentialsToEnv(credentials!), {
    AMR_TOKEN: 'amr-token',
    AMR_API_KEY: 'amr-token',
    AMR_GATEWAY_URL: 'http://127.0.0.1:8787',
  });
});

test('persists AMR credentials in SQLite and clears stale tokens', () => {
  const dir = tempDir('od-amr-db-');
  const db = openDatabase(dir, { dataDir: path.join(dir, '.od') });

  upsertAmrCredentials(db, {
    token: 'token-1',
    gateway: 'http://gateway.local/',
    userId: 'user-1',
    orgId: 'org-1',
    projectId: 'project-1',
    keyId: 'key-1',
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(getAmrCredentials(db)?.token, 'token-1');
  assert.equal(getAmrCredentials(db)?.gateway, 'http://gateway.local');
  clearAmrCredentials(db);
  assert.equal(getAmrCredentials(db), null);
});
