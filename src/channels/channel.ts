// Channel interface: Telegram (grammY, long-poll) and Twilio (webhook-driven) both
// implement this so index.ts and agent.ts don't branch on which one they're talking to.

export interface InboundMessage {
  channel: "telegram" | "twilio";
  chatId: string; // Telegram chat id, or E.164 phone number for Twilio
  text: string;
}

export interface Channel {
  readonly kind: "telegram" | "twilio";
  isAllowed(chatId: string): boolean; // checks ALLOWED_CHAT_IDS
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  send(chatId: string, text: string): Promise<void>;
  start(): Promise<void>; // telegram: begin long polling. twilio: no-op (webhook-driven)
  stop(): Promise<void>; // telegram: stop polling. twilio: no-op
}
