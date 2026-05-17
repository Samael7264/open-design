# AMR Integration

Open Design treats AMR as a local agent runtime. The daemon detects the `amr`
binary, exposes it in the agent picker, and launches turns with:

```bash
amr agent run --stream --output-format stream-json
```

The composed Open Design prompt is written on stdin so large prompts do not
ride argv. The runtime selects a transient AMR base by default
(`base:claude-code`) when the gateway is unavailable. When AMR credentials and
the gateway are available, Open Design resolves or creates the
`open-design-default` AMR Agent resource and runs that saved agent. It also
accepts custom model picker values:

- `base:<adapter>` runs a transient AMR agent on that adapter.
- `agent:<id-or-name>` runs a saved AMR Agent resource.
- Any other custom value is forwarded as `--model`.

## Authentication

On first AMR use, Open Design checks the daemon SQLite `amr_credentials` row,
then falls back to the current AMR session file (`$AMR_SESSION` or
`~/.amr/session.json`). If neither exists, the daemon starts:

```bash
amr login --client-id open-design
```

Desktop Electron registers `open-design://amr-callback` and forwards callback
query fields to the daemon endpoint at `/api/integrations/amr/callback`, which
persists the token in SQLite. Open Design passes
`--callback open-design://amr-callback` when `amr login --help` advertises
support; otherwise it intentionally uses the session-file fallback after login
completes.

At spawn time Open Design injects `AMR_TOKEN`, `AMR_API_KEY`,
`AMR_GATEWAY_URL`, and `AMR_TRACE_ID`. `AMR_API_KEY` is required by current AMR
CLI releases; `AMR_TOKEN` preserves the Open Design integration contract.

AMR-authenticated agent subprocesses also inherit those variables when they
call `od media generate`. For image projects, if no native Open Design media
provider key is configured, the media dispatcher uses the AMR gateway
`fal-image` connector with the same OAuth token instead of asking the user for a
separate image-provider API key.

## Streaming

AMR AgentEvent NDJSON is parsed into the existing Open Design chat event model:

- `agent.token` and assistant `agent.message` become text deltas.
- `agent.thinking` becomes thinking deltas.
- `agent.tool_use`, `agent.file_edit`, and `agent.todo_update` become tool cards.
- `session.done` becomes usage metadata and optional final text.
- `session.start.session_id` is persisted on the conversation and passed back
  as `--resume <session_id>` on later turns.
- `session_thread_id` is preserved on persisted chat events for future AMR
  multi-thread grouping.

## Install Guidance

If AMR is not detected, the Settings agent card exposes these commands:

- macOS: `brew install amr` or `npm install -g @amr/cli`
- Linux: `npm install -g @amr/cli`
- Windows: `npm install -g @amr/cli`
