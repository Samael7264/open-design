type JsonObject = Record<string, unknown>;
type StreamEvent = Record<string, unknown>;
type StreamEventHandler = (event: StreamEvent) => void;
type ParserKind = string;

type ParserState = {
  cursorTextSoFar: string;
  openCodeToolUses: Set<string>;
  codexToolUses: Set<string>;
  codexErrorEmitted: boolean;
  codexPreviousEventWasAgentMessage: boolean;
  codexLastAgentMessageEndedWithNewline: boolean;
  amrSawAssistantText: boolean;
  amrToolUseIds: Set<string>;
  amrFileEditCount: number;
  amrTodoUpdateCount: number;
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
};

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function safeParseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const parsed = safeParseJson(value);
    if (parsed && typeof parsed === 'object') {
      return extractErrorMessage(parsed, value);
    }
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.detail === 'string' && value.detail) return value.detail;
    if (typeof value.message === 'string' && value.message) {
      return extractErrorMessage(value.message, value.message);
    }
    if (typeof value.error === 'string' && value.error) return value.error;
    if (value.error && typeof value.error === 'object') {
      return extractErrorMessage(value.error, fallback);
    }
    if (value.data && typeof value.data === 'object') {
      const dataMessage = extractErrorMessage(value.data, '');
      if (dataMessage) return dataMessage;
    }
    if (typeof value.name === 'string' && value.name) return value.name;
  }
  return fallback;
}

function formatOpenCodeUsage(tokens: unknown): Usage | null {
  if (!isRecord(tokens)) return null;
  const usage: Usage = {};
  if (typeof tokens.input === 'number') usage.input_tokens = tokens.input;
  if (typeof tokens.output === 'number') usage.output_tokens = tokens.output;
  if (typeof tokens.reasoning === 'number') usage.thought_tokens = tokens.reasoning;
  if (isRecord(tokens.cache)) {
    if (typeof tokens.cache.read === 'number') usage.cached_read_tokens = tokens.cache.read;
    if (typeof tokens.cache.write === 'number') usage.cached_write_tokens = tokens.cache.write;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function handleOpenCodeEvent(obj: unknown, onEvent: StreamEventHandler, state: ParserState): boolean {
  if (!isRecord(obj)) return false;
  const part = isRecord(obj.part) ? obj.part : {};

  if (obj.type === 'step_start') {
    onEvent({ type: 'status', label: 'running' });
    return true;
  }

  if (obj.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
    onEvent({ type: 'text_delta', delta: part.text });
    return true;
  }

  if (obj.type === 'tool_use' && typeof part.tool === 'string' && typeof part.callID === 'string') {
    const statePart = isRecord(part.state) ? part.state : null;
    const key = `${obj.sessionID || 'session'}:${part.callID}`;
    if (!state.openCodeToolUses.has(key)) {
      state.openCodeToolUses.add(key);
      onEvent({
        type: 'tool_use',
        id: part.callID,
        name: part.tool,
        input: safeParseJson(statePart?.input) ?? statePart?.input ?? null,
      });
    }
    if (statePart?.status === 'completed') {
      onEvent({
        type: 'tool_result',
        toolUseId: part.callID,
        content: stringifyContent(statePart.output),
        isError: false,
      });
    }
    return true;
  }

  if (obj.type === 'step_finish') {
    const usage = formatOpenCodeUsage(part.tokens);
    if (usage) {
      onEvent({
        type: 'usage',
        usage,
        costUsd: typeof part.cost === 'number' ? part.cost : undefined,
      });
    }
    return true;
  }

  if (obj.type === 'error') {
    // OpenCode emits structured error frames on stdout (e.g. provider auth
    // failures, network errors, schema mismatches) and still exits 0. Surface
    // them as proper `error` events so server.ts's `sendAgentEvent` wrapper
    // can flip the run to `failed` and forward a visible SSE error to the
    // chat UI. Previously we downgraded these to `type:'raw'`, which is not
    // rendered as an assistant message — the run looked like a fast clean
    // success while the user actually got nothing back. See issue #691.
    //
    // Shape mirrors the qoder-stream contract (`{type, message, raw}`) so
    // the daemon's existing error-handling path recognises it without
    // further wiring.
    const message = extractErrorMessage(
      obj.error ?? obj.message,
      'OpenCode error',
    );
    onEvent({ type: 'error', message, raw: stringifyContent(obj) });
    return true;
  }

  return false;
}

function handleGeminiEvent(obj: unknown, onEvent: StreamEventHandler): boolean {
  if (!isRecord(obj)) return false;

  if (obj.type === 'init') {
    onEvent({
      type: 'status',
      label: 'initializing',
      model: typeof obj.model === 'string' ? obj.model : undefined,
    });
    return true;
  }

  if (
    obj.type === 'message' &&
    obj.role === 'assistant' &&
    typeof obj.content === 'string' &&
    obj.content.length > 0
  ) {
    onEvent({ type: 'text_delta', delta: obj.content });
    return true;
  }

  if (obj.type === 'result' && isRecord(obj.stats)) {
    const usage: Usage = {};
    if (typeof obj.stats.input_tokens === 'number') usage.input_tokens = obj.stats.input_tokens;
    if (typeof obj.stats.output_tokens === 'number') usage.output_tokens = obj.stats.output_tokens;
    if (typeof obj.stats.cached === 'number') usage.cached_read_tokens = obj.stats.cached;
    onEvent({
      type: 'usage',
      usage,
      durationMs: typeof obj.stats.duration_ms === 'number' ? obj.stats.duration_ms : undefined,
    });
    return true;
  }

  return false;
}

function extractCursorText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function emitCursorTextDelta(text: string, onEvent: StreamEventHandler, state: ParserState): void {
  if (!state.cursorTextSoFar) {
    state.cursorTextSoFar = text;
    onEvent({ type: 'text_delta', delta: text });
    return;
  }
  if (text === state.cursorTextSoFar) {
    return;
  }
  if (text.startsWith(state.cursorTextSoFar)) {
    const delta = text.slice(state.cursorTextSoFar.length);
    if (delta) onEvent({ type: 'text_delta', delta });
    state.cursorTextSoFar = text;
    return;
  }
  state.cursorTextSoFar += text;
  onEvent({ type: 'text_delta', delta: text });
}

function handleCursorEvent(obj: unknown, onEvent: StreamEventHandler, state: ParserState): boolean {
  if (!isRecord(obj)) return false;

  if (obj.type === 'system' && obj.subtype === 'init') {
    onEvent({
      type: 'status',
      label: 'initializing',
      model: typeof obj.model === 'string' ? obj.model : undefined,
    });
    return true;
  }

  if (obj.type === 'assistant' && obj.message) {
    const text = extractCursorText(obj.message);
    if (!text) return false;
    if (typeof obj.timestamp_ms === 'number') {
      emitCursorTextDelta(text, onEvent, state);
      return true;
    }
    emitCursorTextDelta(text, onEvent, state);
    return true;
  }

  if (obj.type === 'result' && isRecord(obj.usage)) {
    const usage: Usage = {};
    if (typeof obj.usage.inputTokens === 'number') usage.input_tokens = obj.usage.inputTokens;
    if (typeof obj.usage.outputTokens === 'number') usage.output_tokens = obj.usage.outputTokens;
    if (typeof obj.usage.cacheReadTokens === 'number') {
      usage.cached_read_tokens = obj.usage.cacheReadTokens;
    }
    if (typeof obj.usage.cacheWriteTokens === 'number') {
      usage.cached_write_tokens = obj.usage.cacheWriteTokens;
    }
    onEvent({
      type: 'usage',
      usage,
      durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
    });
    return true;
  }

  return false;
}

function handleCodexEvent(obj: unknown, onEvent: StreamEventHandler, state: ParserState): boolean {
  if (!isRecord(obj)) return false;

if (obj.type === 'error') {
  const message = extractErrorMessage(obj.message ?? obj.error, 'Codex error');
  // Reconnecting events are recoverable — treat as status warning, not fatal
  if (
    typeof message === 'string' &&
    message.includes('Reconnecting...') &&
    message.includes('timeout waiting for child process to exit')
  ) {
    onEvent({ type: 'status', label: message });
    return true;
  }
  if (!state.codexErrorEmitted) {
    state.codexErrorEmitted = true;
    onEvent({ type: 'error', message });
  }
  return true;
}

  if (obj.type === 'turn.failed') {
    if (!state.codexErrorEmitted) {
      state.codexErrorEmitted = true;
      onEvent({
        type: 'error',
        message: extractErrorMessage(obj.error ?? obj.message, 'Codex turn failed'),
      });
    }
    return true;
  }

  if (obj.type === 'thread.started') {
    onEvent({ type: 'status', label: 'initializing' });
    return true;
  }

  if (obj.type === 'turn.started') {
    state.codexPreviousEventWasAgentMessage = false;
    state.codexLastAgentMessageEndedWithNewline = false;
    onEvent({ type: 'status', label: 'running' });
    return true;
  }

  if (obj.type === 'item.started' && isRecord(obj.item)) {
    const item = obj.item;
    if (item.type === 'command_execution' && typeof item.id === 'string') {
      state.codexPreviousEventWasAgentMessage = false;
      state.codexLastAgentMessageEndedWithNewline = false;
      if (!state.codexToolUses.has(item.id)) {
        state.codexToolUses.add(item.id);
        onEvent({
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: {
            command: typeof item.command === 'string' ? item.command : '',
          },
        });
      }
      return true;
    }
  }

  if (obj.type === 'item.completed' && isRecord(obj.item)) {
    const item = obj.item;
    if (item.type === 'command_execution' && typeof item.id === 'string') {
      state.codexPreviousEventWasAgentMessage = false;
      state.codexLastAgentMessageEndedWithNewline = false;
      if (!state.codexToolUses.has(item.id)) {
        state.codexToolUses.add(item.id);
        onEvent({
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: {
            command: typeof item.command === 'string' ? item.command : '',
          },
        });
      }
      onEvent({
        type: 'tool_result',
        toolUseId: item.id,
        content: stringifyContent(item.aggregated_output ?? ''),
        isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed',
      });
      return true;
    }
  }

  if (
    obj.type === 'item.completed' &&
    isRecord(obj.item) &&
    obj.item.type === 'agent_message' &&
    typeof obj.item.text === 'string' &&
    obj.item.text.length > 0
  ) {
    const text = obj.item.text;
    const needsBoundary =
      state.codexPreviousEventWasAgentMessage &&
      !state.codexLastAgentMessageEndedWithNewline &&
      !text.startsWith('\n');
    const delta = needsBoundary ? `\n${text}` : text;
    onEvent({ type: 'text_delta', delta });
    state.codexPreviousEventWasAgentMessage = true;
    state.codexLastAgentMessageEndedWithNewline = text.endsWith('\n');
    return true;
  }

  if (obj.type === 'turn.completed' && isRecord(obj.usage)) {
    const usage: Usage = {};
    if (typeof obj.usage.input_tokens === 'number') usage.input_tokens = obj.usage.input_tokens;
    if (typeof obj.usage.output_tokens === 'number') usage.output_tokens = obj.usage.output_tokens;
    if (typeof obj.usage.cached_input_tokens === 'number') {
      usage.cached_read_tokens = obj.usage.cached_input_tokens;
    }
    onEvent({ type: 'usage', usage });
    return true;
  }

  return false;
}

function extractAmrText(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const text = value.map(extractAmrText).filter(Boolean).join('');
    return text.length > 0 ? text : null;
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.delta === 'string') return value.delta;
    if (typeof value.message === 'string') return value.message;
  }
  return null;
}

function formatAmrUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  const usage: Usage = {};
  if (typeof value.input_tokens === 'number') usage.input_tokens = value.input_tokens;
  if (typeof value.output_tokens === 'number') usage.output_tokens = value.output_tokens;
  if (typeof value.thought_tokens === 'number') usage.thought_tokens = value.thought_tokens;
  if (typeof value.reasoning_tokens === 'number') usage.thought_tokens = value.reasoning_tokens;
  if (typeof value.cached_read_tokens === 'number') {
    usage.cached_read_tokens = value.cached_read_tokens;
  }
  if (typeof value.cached_write_tokens === 'number') {
    usage.cached_write_tokens = value.cached_write_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function amrCallId(obj: JsonObject, fallbackPrefix: string, fallbackIndex: number): string {
  return (
    (typeof obj.call_id === 'string' && obj.call_id) ||
    (typeof obj.callId === 'string' && obj.callId) ||
    (typeof obj.id === 'string' && obj.id) ||
    `${fallbackPrefix}-${fallbackIndex}`
  );
}

function amrThreadId(obj: JsonObject): string | undefined {
  return (
    (typeof obj.session_thread_id === 'string' && obj.session_thread_id) ||
    (typeof obj.thread_id === 'string' && obj.thread_id) ||
    undefined
  );
}

function withAmrThreadId<T extends StreamEvent>(event: T, obj: JsonObject): T {
  const threadId = amrThreadId(obj);
  return threadId ? { ...event, threadId } : event;
}

function amrCostUsd(obj: JsonObject): number | undefined {
  if (typeof obj.cost_usd === 'number') return obj.cost_usd;
  if (isRecord(obj.usage) && typeof obj.usage.cost_usd === 'number') {
    return obj.usage.cost_usd;
  }
  return undefined;
}

function handleAmrEvent(
  obj: unknown,
  onEvent: StreamEventHandler,
  state: ParserState,
  rawLine: string,
): boolean {
  if (!isRecord(obj) || typeof obj.type !== 'string') return false;
  const eventType = obj.type;

  if (eventType === 'session.start') {
    onEvent(withAmrThreadId({
      type: 'status',
      label: 'starting',
      model: typeof obj.model === 'string' ? obj.model : undefined,
      detail: typeof obj.adapter === 'string' ? obj.adapter : undefined,
      sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    }, obj));
    return true;
  }

  if (eventType === 'session.end') {
    onEvent(withAmrThreadId({
      type: 'status',
      label: typeof obj.exit_code === 'number' && obj.exit_code !== 0 ? 'ended' : 'done',
      detail: typeof obj.exit_code === 'number' ? `exit ${obj.exit_code}` : undefined,
    }, obj));
    return true;
  }

  if (eventType === 'session.error') {
    onEvent(withAmrThreadId({
      type: 'error',
      message: extractErrorMessage(obj.error ?? obj.message, 'AMR session error'),
      raw: rawLine,
    }, obj));
    return true;
  }

  if (eventType === 'session.done') {
    const resultText = extractAmrText(obj.result ?? obj.output);
    if (resultText && !state.amrSawAssistantText) {
      state.amrSawAssistantText = true;
      onEvent(withAmrThreadId({ type: 'text_delta', delta: resultText }, obj));
    }
    const usage = formatAmrUsage(obj.usage);
    const costUsd = amrCostUsd(obj);
    if (usage || typeof costUsd === 'number' || typeof obj.duration_ms === 'number') {
      onEvent(withAmrThreadId({
        type: 'usage',
        usage: usage ?? undefined,
        costUsd,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      }, obj));
    }
    return true;
  }

  if (eventType === 'agent.token') {
    const text = extractAmrText(obj.delta ?? obj.text ?? obj.content);
    if (text) {
      state.amrSawAssistantText = true;
      onEvent(withAmrThreadId({ type: 'text_delta', delta: text }, obj));
    }
    return true;
  }

  if (eventType === 'agent.message') {
    const role = typeof obj.role === 'string' ? obj.role : 'assistant';
    const text = extractAmrText(obj.content ?? obj.message ?? obj.text);
    if (role === 'assistant' && text && !state.amrSawAssistantText) {
      state.amrSawAssistantText = true;
      onEvent(withAmrThreadId({ type: 'text_delta', delta: text }, obj));
    }
    return true;
  }

  if (eventType === 'agent.thinking') {
    const text = extractAmrText(obj.delta ?? obj.text ?? obj.content);
    if (text) onEvent(withAmrThreadId({ type: 'thinking_delta', delta: text }, obj));
    return true;
  }

  if (eventType === 'agent.tool_use' || eventType === 'agent.custom_tool_use') {
    const id = amrCallId(obj, 'amr-tool', state.amrToolUseIds.size + 1);
    if (!state.amrToolUseIds.has(id)) {
      state.amrToolUseIds.add(id);
      onEvent(withAmrThreadId({
        type: 'tool_use',
        id,
        name:
          (typeof obj.tool === 'string' && obj.tool) ||
          (typeof obj.name === 'string' && obj.name) ||
          'AMRTool',
        input: obj.input ?? obj.arguments ?? null,
      }, obj));
    }
    return true;
  }

  if (eventType === 'user.tool_result' || eventType === 'user.custom_tool_result') {
    const id = amrCallId(obj, 'amr-tool', state.amrToolUseIds.size + 1);
    onEvent(withAmrThreadId({
      type: 'tool_result',
      toolUseId: id,
      content: stringifyContent(obj.output ?? obj.result ?? obj.content),
      isError: Boolean(obj.is_error ?? obj.isError ?? obj.error),
    }, obj));
    return true;
  }

  if (eventType === 'agent.file_edit') {
    state.amrFileEditCount += 1;
    const id = amrCallId(obj, 'amr-file-edit', state.amrFileEditCount);
    onEvent(withAmrThreadId({
      type: 'tool_use',
      id,
      name: 'FileEdit',
      input: {
        path: obj.path ?? obj.file ?? obj.file_path ?? null,
        operation: obj.operation ?? obj.op ?? null,
        diff: obj.diff ?? obj.patch ?? null,
      },
    }, obj));
    return true;
  }

  if (eventType === 'agent.todo_update') {
    state.amrTodoUpdateCount += 1;
    const todos = Array.isArray(obj.todos) ? obj.todos : obj.items;
    onEvent(withAmrThreadId({
      type: 'tool_use',
      id: amrCallId(obj, 'amr-todo-update', state.amrTodoUpdateCount),
      name: 'TodoWrite',
      input: { todos: Array.isArray(todos) ? todos : [] },
    }, obj));
    return true;
  }

  if (eventType === 'user.message') {
    return true;
  }

  onEvent(withAmrThreadId({ type: 'raw', line: rawLine }, obj));
  return true;
}

export function createJsonEventStreamHandler(kind: ParserKind, onEvent: StreamEventHandler) {
  let buffer = '';
  const state: ParserState = {
    cursorTextSoFar: '',
    openCodeToolUses: new Set<string>(),
    codexToolUses: new Set<string>(),
    codexErrorEmitted: false,
    codexPreviousEventWasAgentMessage: false,
    codexLastAgentMessageEndedWithNewline: false,
    amrSawAssistantText: false,
    amrToolUseIds: new Set<string>(),
    amrFileEditCount: 0,
    amrTodoUpdateCount: 0,
  };

  function handleLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      onEvent({ type: 'raw', line });
      return;
    }

    if (kind === 'opencode' && handleOpenCodeEvent(obj, onEvent, state)) return;
    if (kind === 'gemini' && handleGeminiEvent(obj, onEvent)) return;
    if (kind === 'cursor-agent' && handleCursorEvent(obj, onEvent, state)) return;
    if (kind === 'codex' && handleCodexEvent(obj, onEvent, state)) return;
    if (kind === 'amr' && handleAmrEvent(obj, onEvent, state, line)) return;

    onEvent({ type: 'raw', line });
  }

  function feed(chunk: string): void {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleLine(line);
    }
  }

  function flush(): void {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    handleLine(rem);
  }

  return { feed, flush };
}
