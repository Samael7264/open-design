import type { Express } from 'express';
import type Database from 'better-sqlite3';
import {
  amrCredentialsFromCallback,
  clearAmrCredentials,
  getAmrCredentials,
  upsertAmrCredentials,
} from './credentials.js';
import { ensureAmrCredentials } from './login.js';
import { readAppConfig, agentCliEnvForAgent } from '../../app-config.js';
import { resolveAgentLaunch, applyAgentLaunchEnv } from '../../runtimes/launch.js';
import { getAgentDef } from '../../runtimes/registry.js';

type SqliteDb = Database.Database;

type AmrConnectState =
  | { status: 'idle' }
  | { status: 'connecting'; startedAt: number }
  | { status: 'error'; message: string; failedAt: number };

let connectState: AmrConnectState = { status: 'idle' };

function callbackInputFromQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function successHtml(): string {
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>AMR connected</title>',
    '<body>AMR connected. You can return to Open Design.</body>',
  ].join('');
}

export interface AmrIntegrationDeps {
  dataDir: string;
}

export function registerAmrIntegrationRoutes(
  app: Express,
  db: SqliteDb,
  deps: AmrIntegrationDeps,
): void {
  app.post('/api/integrations/amr/callback', (req, res) => {
    const credentials = amrCredentialsFromCallback(req.body ?? {});
    if (!credentials) {
      res.status(400).json({ error: 'missing AMR token' });
      return;
    }
    const saved = upsertAmrCredentials(db, credentials);
    connectState = { status: 'idle' };
    res.json({
      ok: true,
      gateway: saved.gateway,
      userId: saved.userId ?? null,
      orgId: saved.orgId ?? null,
      projectId: saved.projectId ?? null,
      keyId: saved.keyId ?? null,
    });
  });

  app.get('/api/integrations/amr/callback', (req, res) => {
    const credentials = amrCredentialsFromCallback(
      callbackInputFromQuery(req.query as Record<string, unknown>),
    );
    if (!credentials) {
      res.status(400).send('missing AMR token');
      return;
    }
    upsertAmrCredentials(db, credentials);
    connectState = { status: 'idle' };
    res.type('html').send(successHtml());
  });

  app.get('/api/integrations/amr/status', (_req, res) => {
    const credentials = getAmrCredentials(db);
    res.json({
      connected: Boolean(credentials),
      connectState,
      identity: credentials
        ? {
            userId: credentials.userId ?? null,
            orgId: credentials.orgId ?? null,
            projectId: credentials.projectId ?? null,
            keyId: credentials.keyId ?? null,
            gateway: credentials.gateway,
          }
        : null,
    });
  });

  // Start the OAuth flow in the background. Returns 202 immediately —
  // `amr login` can block for 2-3 minutes waiting on the user's browser,
  // so we don't make the HTTP client wait. The UI polls /status to learn
  // when credentials land (via Electron deep-link → /callback above).
  app.post('/api/integrations/amr/connect', async (_req, res) => {
    if (getAmrCredentials(db)) {
      res.status(200).json({ ok: true, alreadyConnected: true });
      return;
    }
    if (connectState.status === 'connecting') {
      res.status(202).json({ ok: true, alreadyRunning: true });
      return;
    }
    let amrDef;
    try {
      amrDef = getAgentDef('amr');
    } catch {
      amrDef = null;
    }
    if (!amrDef) {
      res.status(500).json({ error: 'amr runtime definition unavailable' });
      return;
    }
    let amrBin: string | null = null;
    let amrEnv: NodeJS.ProcessEnv;
    try {
      const config = await readAppConfig(deps.dataDir);
      const configuredEnv = agentCliEnvForAgent(config.agentCliEnv, 'amr');
      const launch = resolveAgentLaunch(amrDef, configuredEnv);
      amrBin = launch.launchPath ?? null;
      amrEnv = applyAgentLaunchEnv(
        { ...process.env, ...(amrDef.env ?? {}), ...configuredEnv },
        launch,
      ) as NodeJS.ProcessEnv;
    } catch (err) {
      res.status(500).json({
        error: `unable to resolve amr launch: ${(err as Error).message ?? String(err)}`,
      });
      return;
    }
    if (!amrBin) {
      res.status(409).json({
        error:
          'amr is not installed or not on PATH. Install it (npm i -g @amr/cli or brew install amr), then click Rescan and retry.',
      });
      return;
    }
    connectState = { status: 'connecting', startedAt: Date.now() };
    res.status(202).json({ ok: true });
    // Fire-and-forget — connectState transitions back via the callback
    // route on success, or via the catch below on failure.
    ensureAmrCredentials({ db, amrBin, env: amrEnv })
      .then(() => {
        connectState = { status: 'idle' };
      })
      .catch((err) => {
        const message =
          err && (err as Error).message
            ? (err as Error).message
            : String(err ?? 'amr login failed');
        connectState = { status: 'error', message, failedAt: Date.now() };
        console.warn('[amr] connect flow failed:', message);
      });
  });

  app.post('/api/integrations/amr/disconnect', (_req, res) => {
    try {
      clearAmrCredentials(db);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message ?? String(err) });
      return;
    }
    connectState = { status: 'idle' };
    res.json({ ok: true });
  });
}
