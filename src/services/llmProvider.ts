/**
 * Thin LLM wrapper. The default impl is "no-op template" so the agent works
 * without an API key; an OpenAI/Anthropic adapter can be plugged in later.
 */
export interface LlmProvider {
  /** True if a real model is configured (false = templates only). */
  readonly enabled: boolean;

  /** Complete a chat turn. Returns plain text or empty string on failure. */
  complete(input: {
    system?: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
}

/** No-op provider used when no API key is configured. */
export class TemplateLlm implements LlmProvider {
  readonly enabled = false;
  async complete(_input: {
    system?: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    return "";
  }
}
