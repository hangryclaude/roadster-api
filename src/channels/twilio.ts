// TwilioChannel: fetch-backed Channel implementation (inbound webhook parse +
// outbound send via Twilio's REST API, not TwiML, so the scheduler poller can send
// too, not just in direct response to a webhook).

import { createHmac } from "node:crypto";
import type { Channel, InboundMessage } from "./channel.ts";

// Twilio's request-signature scheme: HMAC-SHA1(authToken, url + sorted-concatenated
// param key+value pairs), base64-encoded, compared to the X-Twilio-Signature header.
// https://www.twilio.com/docs/usage/security#validating-requests
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  return expected === signatureHeader;
}

// Twilio signs the public URL it POSTed to. Behind a TLS-terminating proxy, Node sees
// a plain-HTTP local request while Twilio signed the public HTTPS one — reconstruct
// that public URL from the forwarded headers (or a configured base) before
// validating, instead of trusting the raw local req.url.
function publicUrlFor(req: Request, publicBaseUrl: string | undefined): string {
  const local = new URL(req.url);
  if (publicBaseUrl) {
    const base = new URL(publicBaseUrl);
    return `${base.protocol}//${base.host}${local.pathname}${local.search}`;
  }
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) {
    return `${proto}://${host}${local.pathname}${local.search}`;
  }
  return req.url;
}

// How long a processed MessageSid is remembered for dedup purposes. A retried
// delivery after a slow response typically lands within seconds, not hours — this is
// a generous window without growing the in-memory set unboundedly across a long-lived
// process (old entries are swept lazily on each check).
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export class TwilioChannel implements Channel {
  readonly kind = "twilio" as const;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private readonly seenMessageSids = new Map<string, number>();

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly allowedChatIds: Set<string>,
    // Configured public base URL (scheme+host) to sign against when behind a
    // TLS-terminating proxy that doesn't set X-Forwarded-* headers. Optional —
    // falls back to those headers, then to the raw request URL.
    private readonly publicBaseUrl?: string,
  ) {}

  isAllowed(chatId: string): boolean {
    return this.allowedChatIds.has(chatId);
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(chatId: string, text: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const body = new URLSearchParams({ From: this.fromNumber, To: chatId, Body: text });
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
    }
  }

  async start(): Promise<void> {
    // webhook-driven, no-op
  }

  async stop(): Promise<void> {
    // webhook-driven, no-op
  }

  // True if this MessageSid was already processed within the dedup window — Twilio
  // retries/replays a delivery (e.g. after a slow response) with the same SID, and
  // that must no-op rather than re-executing the same command or re-creating the
  // same schedule. Records aren't bothered to be pruned eagerly; a stale entry just
  // ages out of the window on the next check.
  private isDuplicate(messageSid: string | undefined, nowMs: number): boolean {
    if (!messageSid) return false; // nothing to dedup on — pass through as before
    for (const [sid, seenAt] of this.seenMessageSids) {
      if (nowMs - seenAt > DEDUP_WINDOW_MS) this.seenMessageSids.delete(sid);
    }
    if (this.seenMessageSids.has(messageSid)) return true;
    this.seenMessageSids.set(messageSid, nowMs);
    return false;
  }

  // Called from the Hono route (POST /twilio/sms). Parses the form-encoded
  // From/Body, verifies the request signature, and replies with an empty 200
  // (the actual reply to the owner goes out via send() -> Twilio's REST API, not
  // TwiML, so the scheduler poller can send unprompted too).
  //
  // STOP and HELP are Twilio carrier-reserved opt-out/help keywords. Twilio
  // intercepts them before most accounts ever see the webhook; on the rare chance
  // one does arrive here, it is passed through to the handler untouched at this
  // layer — agent.ts's handleInbound is what actually guarantees STOP never reaches
  // the model loop, because that carrier behavior is sacred and must not collide
  // with app-level logic regardless of which layer enforces it.
  async handleWebhook(req: Request): Promise<Response> {
    const bodyText = await req.text();
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(bodyText)) {
      params[key] = value;
    }

    const signature = req.headers.get("X-Twilio-Signature");
    const publicUrl = publicUrlFor(req, this.publicBaseUrl);
    const valid = validateTwilioSignature(this.authToken, publicUrl, params, signature);
    if (!valid) {
      return new Response("invalid signature", { status: 403 });
    }

    const from = params.From;
    const body = params.Body ?? "";
    if (from && this.handler && this.isAllowed(from) && !this.isDuplicate(params.MessageSid, Date.now())) {
      await this.handler({ channel: "twilio", chatId: from, text: body });
    }

    return new Response("", {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  }
}
