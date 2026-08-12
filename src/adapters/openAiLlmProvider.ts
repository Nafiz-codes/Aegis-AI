import type { LlmProvider } from "../services/llmProvider.js";

export interface OpenAiLlmOptions {
  apiKey: string;
  model?: string;
  /** Request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** OpenAI base URL (override for Azure/proxy/etc). */
  baseUrl?: string;
}

/**
 * LLM provider that targets the OpenAI Chat Completions API. The agent always
 * asks for plain-text JSON, so we do not need to pass `response_format`. We
 * still allow the caller to inject a base URL for proxies.
 *
 * The provider is intentionally minimal: it implements the {@link LlmProvider}
 * contract, surfaces network/timeout errors as `Error`, and never throws on
 * non-2xx responses (it returns an empty string so the agent falls back).
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly enabled = true;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiLlmOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gpt-4o-mini";
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async complete(input: {
    system?: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(input.system ? [{ role: "system", content: input.system }] : []),
            { role: "user", content: input.user },
          ],
          max_tokens: input.maxTokens ?? 400,
          temperature: input.temperature ?? 0.2,
        }),
      });
      if (!res.ok) {
        // Return empty string so the agent falls back gracefully.
        return "";
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }
}
