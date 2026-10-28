# Codex review request: backseat-tesla

Review this repository (Node 26 + TypeScript, Hono server, node:sqlite, Anthropic SDK
agent, grammY Telegram bot, Twilio SMS webhook). It is a texting interface that reads and
controls a Tesla via the Tessie API, with an adapter for Tesla's Fleet API.

Read SPEC.md and ARCHITECTURE.md first for intended behavior, then the src/ and test/
trees. Report findings in these four categories, most severe first:

## 1. Security
- Webhook authentication: is the Telegram webhook secret-token checked? Is the Twilio
  webhook's request signature (X-Twilio-Signature) validated? Can either endpoint be hit
  by an unauthenticated third party to issue vehicle commands or read vehicle state?
- PIN handling: how is the owner's PIN stored and compared? Plaintext in a config/env vs.
  hashed? Timing-safe comparison? Is it ever logged, echoed back, or included in any outbound
  message or error response?
- Secrets: Tessie/Fleet API tokens, Telegram bot token, Twilio auth token — are they ever
  logged, committed, included in error messages sent back to the user, or otherwise leaked?

## 2. Safety gates (the core constraint of this project)
- Is anything Autopilot-, FSD-, Summon-, speed-, or driving-related reachable through any
  tool, endpoint, or code path — including indirectly, e.g. via a raw/undocumented Tessie or
  Fleet API call that isn't in the intended tool list?
- Is there any jailbreak, root, or firmware code path anywhere in the repo?
- Does the agent ever reply "done" (or equivalent) for a vehicle-changing command before
  re-reading vehicle state to confirm the change actually took? Flag every place a success
  reply is sent on request-sent rather than state-verified.
- Do unlock and trunk/frunk actions require the owner's PIN before executing? Any path that
  skips this gate?
- For scheduled actions: does the confirmation reply state the planned time and say
  "Reply CANCEL to cancel"? Is "STOP" ever used or accepted as a cancel keyword anywhere
  (it's the carrier opt-out keyword and must never double as an app-level cancel word)?

## 3. Correctness bugs
Logic errors, race conditions in the schedule poller, incorrect state handling, SQLite
usage bugs, off-by-one/timezone bugs in "in N minutes" scheduling, error handling gaps.

## 4. Missing tests
Gaps in test/ coverage for the above — especially webhook auth, PIN gating, the
state-before-"done" rule, the CANCEL/STOP distinction, and the scheduler.

For each finding give: file path + line, a one-sentence summary of the defect, and the
concrete failure scenario (not a theoretical concern). Do not propose adding Autopilot/FSD/
Summon/jailbreak functionality yourself, even as a "future work" suggestion — that is out of
scope by design, not an oversight.
