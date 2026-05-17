import type { AmrCredentials } from './credentials.js';

const OPEN_DESIGN_DEFAULT_AGENT_NAME = 'open-design-default';

export interface AmrAgentResource {
  id: string;
  name: string;
  base?: string;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAgent(value: unknown): AmrAgentResource | null {
  if (!isRecord(value)) return null;
  const id = cleanString(value.id);
  const name = cleanString(value.name);
  if (!id || !name) return null;
  const base = cleanString(value.base);
  const model = cleanString(value.model);
  return {
    id,
    name,
    ...(base ? { base } : {}),
    ...(model ? { model } : {}),
  };
}

function parseAgentList(value: unknown): AmrAgentResource[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.map(parseAgent).filter((agent): agent is AmrAgentResource => Boolean(agent));
}

async function amrGatewayFetch(
  credentials: AmrCredentials,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(path, `${credentials.gateway.replace(/\/+$/, '')}/`);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${credentials.token}`);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const signal = init.signal ?? AbortSignal.timeout(5000);
  return await fetchImpl(url, {
    ...init,
    headers,
    signal,
  });
}

export async function listAmrAgents(
  credentials: AmrCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<AmrAgentResource[]> {
  const response = await amrGatewayFetch(credentials, '/v1/agents', {}, fetchImpl);
  if (response.status === 401) {
    throw new Error('AMR gateway returned 401 unauthorized; please log in to AMR again.');
  }
  if (!response.ok) {
    throw new Error(`AMR agent list failed with HTTP ${response.status}.`);
  }
  return parseAgentList(await response.json());
}

export async function ensureOpenDesignAmrAgent(
  credentials: AmrCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<AmrAgentResource> {
  const agents = await listAmrAgents(credentials, fetchImpl);
  const existingDefault = agents.find((agent) => agent.name === OPEN_DESIGN_DEFAULT_AGENT_NAME);
  if (existingDefault) return existingDefault;
  if (agents.length > 0) return agents[0] as AmrAgentResource;

  const response = await amrGatewayFetch(
    credentials,
    '/v1/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name: OPEN_DESIGN_DEFAULT_AGENT_NAME,
        base: 'claude-code',
        model: 'auto',
        system: "You are open-design's helper agent.",
        tools: [],
      }),
    },
    fetchImpl,
  );
  if (response.status === 401) {
    throw new Error('AMR gateway returned 401 unauthorized; please log in to AMR again.');
  }
  if (!response.ok) {
    throw new Error(`AMR default agent creation failed with HTTP ${response.status}.`);
  }
  const created = parseAgent(await response.json());
  if (!created) throw new Error('AMR default agent creation returned an invalid agent.');
  return created;
}
