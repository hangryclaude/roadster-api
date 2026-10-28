// TelegramChannel: grammY-backed Channel implementation.

import { Bot } from "grammy";
import type { Channel, InboundMessage } from "./channel.ts";

// Never let a raw error reach stdout/stderr here — a command error thrown while
// processing a PIN challenge carries the owner's PIN in the message text, and any
// error touching the grammY Bot instance can carry the bot token in its context.
// Logging only the error's name is enough to see something failed without leaking
// either.
function logRedacted(context: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`telegram: ${context} failed (${name})`);
}

export class TelegramChannel implements Channel {
  readonly kind = "telegram" as const;
  private readonly bot: Bot;

  constructor(
    botToken: string,
    private readonly allowedChatIds: Set<string>,
  ) {
    this.bot = new Bot(botToken);
  }

  isAllowed(chatId: string): boolean {
    return this.allowedChatIds.has(chatId);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.bot.on("message:text", async (ctx) => {
      try {
        const chatId = String(ctx.chat.id);
        if (!this.isAllowed(chatId)) return; // anyone else's message is ignored, not answered
        await handler({ channel: "telegram", chatId, text: ctx.message.text });
      } catch (err) {
        // Swallowed here, not rethrown: letting this propagate hits grammY's default
        // handler, which surfaces to Node's unhandled-rejection output — and that
        // output can include the bot token and, during a PIN challenge, the PIN
        // itself, straight into logs.
        logRedacted("message handler", err);
      }
    });
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  async start(): Promise<void> {
    // Fire-and-forget: grammY's start() resolves only when polling stops, so
    // awaiting it here would hang the caller (index.ts boot) forever. The .catch is
    // the fix for the unhandled-rejection leak described in logRedacted above —
    // without it, any polling-start failure (including ones carrying the token in
    // their error context) reaches stdout/stderr unredacted.
    this.bot.start().catch((err) => logRedacted("polling start", err));
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
