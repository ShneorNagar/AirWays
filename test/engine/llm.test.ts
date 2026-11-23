import { describe, expect, it } from "vitest";
import { AnthropicClient, LLMError, buildRequestBody, parseResponseBody, type LLMRequest } from "../../src/engine/llm";

const req: LLMRequest = {
  model: "claude-haiku-5-5",
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 100,
  temperature: null,
  disable_thinking: true,
  tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
  tool_choice: { type: "tool", name: "t" },
};

const okBody = {
  content: [
    { type: "text", text: "a" },
    { type: "tool_use", id: "x", name: "t", input: { k: 1 } },
    { type: "text", text: "b" },
  ],
  usage: { input_tokens: 11, output_tokens: 7 },
};

function fakeFetch(responses: (Response | Error)[]) {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("request/response mapping", () => {
  it("omits temperature when null and disables thinking", () => {
    const body = buildRequestBody(req);
    expect(body).not.toHaveProperty("temperature");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "t" });
  });
  it("sends temperature when configured", () => {
    expect(buildRequestBody({ ...req, temperature: 0.7, disable_thinking: false })).toMatchObject({ temperature: 0.7 });
    expect(buildRequestBody({ ...req, disable_thinking: false })).not.toHaveProperty("thinking");
  });
  it("concatenates text and takes the first tool_use input", () => {
    expect(parseResponseBody(okBody)).toEqual({ text: "ab", toolInput: { k: 1 }, inputTokens: 11, outputTokens: 7 });
  });
  it("handles a refusal with empty content", () => {
    expect(parseResponseBody({ stop_reason: "refusal", content: [], usage: { input_tokens: 5, output_tokens: 0 } })).toEqual({
      text: "", toolInput: null, inputTokens: 5, outputTokens: 0,
    });
  });
});

describe("AnthropicClient", () => {
  it("sends the required headers and reports usage", async () => {
    const { impl, calls } = fakeFetch([json(200, okBody)]);
    const usage: unknown[] = [];
    const c = new AnthropicClient({ apiKey: "k", fetchImpl: impl, onUsage: (u) => void usage.push(u), sleep: async () => {} });
    const res = await c.call(req, "judge");
    expect(res.text).toBe("ab");
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    expect(usage).toEqual([{ role: "judge", model: "claude-haiku-5-5", inputTokens: 11, outputTokens: 7 }]);
  });

  it("retries 429, 5xx and network errors with 1s/2s/4s backoff", async () => {
    const { impl, calls } = fakeFetch([json(429, {}), new TypeError("fetch failed"), json(529, {}), json(200, okBody)]);
    const sleeps: number[] = [];
    const c = new AnthropicClient({ apiKey: "k", fetchImpl: impl, sleep: async (ms) => void sleeps.push(ms) });
    await expect(c.call(req, "attacker")).resolves.toMatchObject({ text: "ab" });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("gives up after LLM_RETRIES retries", async () => {
    const { impl, calls } = fakeFetch([json(500, {}), json(500, {}), json(500, {}), json(500, {}), json(200, okBody)]);
    const c = new AnthropicClient({ apiKey: "k", fetchImpl: impl, sleep: async () => {} });
    await expect(c.call(req, "attacker")).rejects.toMatchObject({ name: "LLMError", status: 500 });
    expect(calls).toHaveLength(4);
  });

  it("throws immediately on other 4xx", async () => {
    const { impl, calls } = fakeFetch([json(400, { error: { message: "bad" } }), json(200, okBody)]);
    const c = new AnthropicClient({ apiKey: "k", fetchImpl: impl, sleep: async () => {} });
    const err = await c.call(req, "defender").catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
