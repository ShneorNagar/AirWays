import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  LLM_BACKOFF_MS,
  LLM_RETRIES,
} from "./config";

export type LLMRole = "attacker" | "defender" | "judge";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  max_tokens: number;
  /** null = do not send (see config.ts: the current model rejects non-default values). */
  temperature: number | null;
  /** When true, sends `thinking: {type: "disabled"}`. */
  disable_thinking?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: "tool"; name: string };
}

export interface LLMResponse {
  text: string; // concatenated text blocks
  toolInput: Record<string, unknown> | null; // input of the first tool_use block
  inputTokens: number;
  outputTokens: number;
}

export interface UsageEvent {
  role: LLMRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type UsageCallback = (u: UsageEvent) => void | Promise<void>;

export interface LLMClient {
  call(req: LLMRequest, role: LLMRole): Promise<LLMResponse>;
}

/** Thrown when an LLM call fails permanently (after retries, or a non-retryable 4xx). */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export function buildRequestBody(req: LLMRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    system: req.system,
    messages: req.messages,
    max_tokens: req.max_tokens,
  };
  if (req.temperature !== null) body.temperature = req.temperature;
  if (req.disable_thinking) body.thinking = { type: "disabled" };
  if (req.tools) body.tools = req.tools;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  return body;
}

interface ApiContentBlock {
  type: string;
  text?: string;
  input?: unknown;
}

export function parseResponseBody(json: unknown): LLMResponse {
  const obj = (json ?? {}) as { content?: ApiContentBlock[]; usage?: Record<string, unknown> };
  const content = Array.isArray(obj.content) ? obj.content : [];
  let text = "";
  let toolInput: Record<string, unknown> | null = null;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use" && toolInput === null) {
      const input = block.input;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        toolInput = input as Record<string, unknown>;
      }
    }
  }
  const usage = obj.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // input_tokens excludes cached tokens; we do not use prompt caching, but count them anyway.
  const inputTokens =
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens);
  return { text, toolInput, inputTokens, outputTokens: num(usage.output_tokens) };
}

export interface AnthropicClientOptions {
  apiKey: string;
  onUsage?: UsageCallback;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  url?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AnthropicClient implements LLMClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AnthropicClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async call(req: LLMRequest, role: LLMRole): Promise<LLMResponse> {
    const body = JSON.stringify(buildRequestBody(req));
    let lastError: LLMError | null = null;

    for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
      if (attempt > 0) {
        await this.sleep(LLM_BACKOFF_MS[attempt - 1] ?? LLM_BACKOFF_MS[LLM_BACKOFF_MS.length - 1]!);
      }
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.url ?? ANTHROPIC_API_URL, {
          method: "POST",
          headers: {
            "x-api-key": this.opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        lastError = new LLMError(`network error: ${(err as Error).message}`, null);
        continue; // retry network errors
      }

      if (res.ok) {
        const parsed = parseResponseBody(await res.json());
        if (this.opts.onUsage) {
          await this.opts.onUsage({
            role,
            model: req.model,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
          });
        }
        return parsed;
      }

      const errText = await res.text().catch(() => "");
      const err = new LLMError(`HTTP ${res.status}: ${errText.slice(0, 500)}`, res.status);
      if (res.status === 429 || res.status >= 500) {
        lastError = err;
        continue; // retryable
      }
      throw err; // other 4xx: fail immediately
    }
    throw lastError ?? new LLMError("LLM call failed", null);
  }
}

/** A scripted response: a partial LLMResponse, an Error to throw, or a function of the request. */
export type MockStep =
  | Partial<LLMResponse>
  | Error
  | ((req: LLMRequest) => Partial<LLMResponse> | Error);

export class MockLLMClient implements LLMClient {
  readonly calls: { role: LLMRole; req: LLMRequest }[] = [];
  private readonly queues: Record<LLMRole, MockStep[]>;

  constructor(
    script: Partial<Record<LLMRole, MockStep[]>>,
    private readonly onUsage?: UsageCallback,
    /** Used when a role's queue is empty; if absent, an empty queue throws. */
    private readonly fallback?: Partial<Record<LLMRole, MockStep>>,
  ) {
    this.queues = {
      attacker: [...(script.attacker ?? [])],
      defender: [...(script.defender ?? [])],
      judge: [...(script.judge ?? [])],
    };
  }

  callsFor(role: LLMRole) {
    return this.calls.filter((c) => c.role === role);
  }

  remaining(role: LLMRole) {
    return this.queues[role].length;
  }

  async call(req: LLMRequest, role: LLMRole): Promise<LLMResponse> {
    this.calls.push({ role, req });
    let step = this.queues[role].shift() ?? this.fallback?.[role];
    if (step === undefined) throw new Error(`MockLLMClient: no scripted response for ${role}`);
    if (typeof step === "function") step = step(req);
    if (step instanceof Error) throw step;
    const res: LLMResponse = {
      text: step.text ?? "",
      toolInput: step.toolInput ?? null,
      inputTokens: step.inputTokens ?? 0,
      outputTokens: step.outputTokens ?? 0,
    };
    if (this.onUsage) {
      await this.onUsage({
        role,
        model: req.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
    }
    return res;
  }
}
