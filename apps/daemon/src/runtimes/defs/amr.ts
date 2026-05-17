import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';
import { listAmrAgents } from '../../integrations/amr/agents.js';
import { readAmrSessionFile } from '../../integrations/amr/credentials.js';

function cleanSelector(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== 'default' ? trimmed : null;
}

export const amrAgentDef = {
  id: 'amr',
  name: 'AMR',
  bin: 'amr',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'base:claude-code', label: 'Claude Code base' },
    { id: 'base:codex', label: 'Codex base' },
    { id: 'base:opencode', label: 'OpenCode base' },
  ],
  fetchModels: async (_resolvedBin, env) => {
    const credentials = readAmrSessionFile(env);
    if (!credentials) return null;
    const agents = await listAmrAgents(credentials, fetch);
    if (agents.length === 0) return null;
    return [
      DEFAULT_MODEL_OPTION,
      ...agents.map((agent) => ({
        id: `agent:${agent.id}`,
        label: `${agent.name}${agent.base ? ` (${agent.base})` : ''}`,
      })),
      { id: 'base:claude-code', label: 'Claude Code base' },
      { id: 'base:codex', label: 'Codex base' },
      { id: 'base:opencode', label: 'OpenCode base' },
    ];
  },
  buildArgs: (
    _prompt,
    _imagePaths,
    _extraAllowedDirs = [],
    options = {},
    runtimeContext = {},
  ) => {
    const args = [
      'agent',
      'run',
      '--stream',
      '--output-format',
      'stream-json',
    ];
    const selected = cleanSelector(options.model);
    let usesAgentRef = false;
    let base = 'claude-code';
    let model: string | null = null;
    if (selected?.startsWith('agent:')) {
      const agentRef = cleanSelector(selected.slice('agent:'.length));
      if (agentRef) {
        args.splice(2, 0, agentRef);
        usesAgentRef = true;
      }
    } else if (runtimeContext.amrAgentRef) {
      args.splice(2, 0, runtimeContext.amrAgentRef);
      usesAgentRef = true;
    } else if (selected?.startsWith('base:')) {
      base = selected.slice('base:'.length).trim() || base;
    } else if (selected) {
      model = selected;
    }
    if (runtimeContext.cwd) {
      args.push('-w', runtimeContext.cwd);
    }
    if (!usesAgentRef) {
      args.push('--base', base);
    }
    if (model) {
      args.push('--model', model);
    }
    if (runtimeContext.amrSessionId) {
      args.push('--resume', runtimeContext.amrSessionId);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'amr',
} satisfies RuntimeAgentDef;
