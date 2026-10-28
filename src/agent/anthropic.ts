// Minimal local shape of the Anthropic SDK surface this module needs, so tests can
// inject a fake client without pulling in @anthropic-ai/sdk's own types. agent.ts
// talks to this interface only; src/index.ts is responsible for adapting the real
// SDK client to it.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type AnthropicMessageContent =
  | string
  | Array<AnthropicContentBlock | AnthropicToolResultBlock>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicMessageContent;
}

export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: object;
}

export interface AnthropicCreateParams {
  system: string;
  messages: AnthropicMessage[];
  tools: AnthropicToolSchema[];
}

export interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
}

export interface AnthropicClientLike {
  createMessage(params: AnthropicCreateParams): Promise<AnthropicResponse>;
}
