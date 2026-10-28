import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TwilioChannel, validateTwilioSignature } from "../src/channels/twilio.ts";
import { TelegramChannel } from "../src/channels/telegram.ts";

test("TwilioChannel.isAllowed checks ALLOWED_CHAT_IDS", () => {
  const channel = new TwilioChannel("sid", "token", "+15551234567", new Set(["+15559876543"]));
  assert.equal(channel.isAllowed("+15559876543"), true);
  assert.equal(channel.isAllowed("+19999999999"), false);
});

test("validateTwilioSignature accepts a correctly computed signature", () => {
  const authToken = "test-auth-token";
  const url = "https://example.com/twilio/sms";
  const params = { From: "+15559876543", Body: "unlock it" };
  const expected = createHmac("sha1", authToken)
    .update(url + "Bodyunlock it" + "From+15559876543", "utf8")
    .digest("base64");

  assert.equal(validateTwilioSignature(authToken, url, params, expected), true);
});

test("validateTwilioSignature rejects a tampered body or missing header", () => {
  const authToken = "test-auth-token";
  const url = "https://example.com/twilio/sms";
  const params = { From: "+15559876543", Body: "unlock it" };
  const wrongSig = createHmac("sha1", authToken)
    .update(url + "Bodysomething else" + "From+15559876543", "utf8")
    .digest("base64");

  assert.equal(validateTwilioSignature(authToken, url, params, wrongSig), false);
  assert.equal(validateTwilioSignature(authToken, url, params, null), false);
});

test("TwilioChannel.handleWebhook rejects requests with a bad signature", async () => {
  const channel = new TwilioChannel("sid", "test-auth-token", "+15551234567", new Set(["+15559876543"]));
  let handlerCalled = false;
  channel.onMessage(async () => {
    handlerCalled = true;
  });

  const req = new Request("https://example.com/twilio/sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": "not-a-real-signature",
    },
    body: new URLSearchParams({ From: "+15559876543", Body: "honk it" }).toString(),
  });

  const res = await channel.handleWebhook(req);
  assert.equal(res.status, 403);
  assert.equal(handlerCalled, false);
});

test("TwilioChannel.handleWebhook accepts a valid signature and dispatches to the handler", async () => {
  const authToken = "test-auth-token";
  const channel = new TwilioChannel("sid", authToken, "+15551234567", new Set(["+15559876543"]));
  let received: { chatId: string; text: string } | null = null;
  channel.onMessage(async (msg) => {
    received = { chatId: msg.chatId, text: msg.text };
  });

  const url = "https://example.com/twilio/sms";
  const bodyParams = { From: "+15559876543", Body: "honk it" };
  const signature = createHmac("sha1", authToken)
    .update(url + "Bodyhonk it" + "From+15559876543", "utf8")
    .digest("base64");

  const req = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  const res = await channel.handleWebhook(req);
  assert.equal(res.status, 200);
  assert.deepEqual(received, { chatId: "+15559876543", text: "honk it" });
});

test("TwilioChannel.handleWebhook ignores a sender not in ALLOWED_CHAT_IDS", async () => {
  const authToken = "test-auth-token";
  const channel = new TwilioChannel("sid", authToken, "+15551234567", new Set(["+15559876543"]));
  let handlerCalled = false;
  channel.onMessage(async () => {
    handlerCalled = true;
  });

  const url = "https://example.com/twilio/sms";
  const bodyParams = { From: "+19999999999", Body: "unlock it" };
  const signature = createHmac("sha1", authToken)
    .update(url + "Bodyunlock it" + "From+19999999999", "utf8")
    .digest("base64");

  const req = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  const res = await channel.handleWebhook(req);
  assert.equal(res.status, 200); // still 200 — don't leak allowlist info via status code
  assert.equal(handlerCalled, false);
});

test("TwilioChannel.handleWebhook dedupes a retried delivery by MessageSid", async () => {
  const authToken = "test-auth-token";
  const channel = new TwilioChannel("sid", authToken, "+15551234567", new Set(["+15559876543"]));
  let calls = 0;
  channel.onMessage(async () => {
    calls += 1;
  });

  const url = "https://example.com/twilio/sms";
  const bodyParams = { From: "+15559876543", Body: "unlock it", MessageSid: "SM123" };
  const sortedKeys = Object.keys(bodyParams).sort();
  let data = url;
  for (const key of sortedKeys) data += key + (bodyParams as Record<string, string>)[key];
  const realSignature = createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const makeReq = () =>
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": realSignature,
      },
      body: new URLSearchParams(bodyParams).toString(),
    });

  const first = await channel.handleWebhook(makeReq());
  const second = await channel.handleWebhook(makeReq());
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls, 1, "a retried delivery with the same MessageSid must not re-execute the command");
});

test("validateTwilioSignature with a reconstructed public HTTPS URL matches what Twilio signed", () => {
  const authToken = "test-auth-token";
  const publicUrl = "https://backseat.example.com/twilio/sms";
  const params = { From: "+15559876543", Body: "lock it" };
  const expected = createHmac("sha1", authToken)
    .update(publicUrl + "Bodylock it" + "From+15559876543", "utf8")
    .digest("base64");
  // Simulates what a TLS-terminating proxy forwards: Node sees plain HTTP locally,
  // but the signature was computed against the public HTTPS URL.
  assert.equal(validateTwilioSignature(authToken, publicUrl, params, expected), true);
});

test("TelegramChannel.isAllowed checks ALLOWED_CHAT_IDS (chat id form)", () => {
  const channel = new TelegramChannel("fake-bot-token", new Set(["111222333"]));
  assert.equal(channel.isAllowed("111222333"), true);
  assert.equal(channel.isAllowed("999999999"), false);
});
