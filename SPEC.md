# backseat-tesla — SPEC

A cloud agent the owner texts (Telegram first, Twilio SMS second) that reads and controls
their Tesla with no hardware installed in the car, via the Tessie API (primary) and an
adapter interface for Tesla's official Fleet API (secondary/future). Pattern and terms
(tool allowlist, ack chain, scheduling, SMS keywords) carry over from `backseat`
(`backseat/cloud/ARCHITECTURE.md`, `backseat/research/03-software-design.md`) — same
shape, Tesla-only, no dongle, no brand-specific interlocks because Tessie/Fleet API already
gate what's reachable.

## Goals

- Text the car in plain English over Telegram (day 1) or SMS (Twilio, second channel) and
  get it to do something, or tell you something, within seconds.
- Cover the full surface the Tessie API (and, behind the same interface, Tesla's Fleet API)
  actually expose: climate, locks, charging, charge port, trunk/frunk, honk, flash, sentry,
  nav-send, scheduled departure, vent windows, and read-only state (odometer, battery,
  location, charge state, lock state).
- Make "in N minutes" actually happen via a durable schedule (SQLite triggers table + poller),
  not a prayer that the process stays alive.
- Never say "done" until the agent has re-read vehicle state and confirmed the change actually
  took — not just that a request was sent.
- Gate the two commands that matter (unlock, trunk) behind a PIN the owner set themselves;
  gate every scheduled command behind a clear cancel word that is not a carrier-reserved one.

## What this will never do

(Verbatim from the project's hard rules — not negotiable, not reinterpretable per-feature.)

- ONLY vehicle functions the official APIs expose: climate on/off, set temp, lock/unlock,
  charge start/stop/limit, charge port, trunk/frunk, honk, flash, sentry, nav send destination,
  scheduled departure, vent windows, read odometer/battery/location/charge state/lock state.
  **NEVER anything touching Autopilot, FSD, steering, Summon, speed, or driving.**
  **NEVER any jailbreak, root, or firmware work.** If asked, refuse in code comments and docs.
- Never use `mcp__claude-in-chrome__*` tools. Never git commit. Never touch files outside this
  repo. Do not use any local Ollama model.

This is why there is no "autopilot," "FSD," "summon," or "drive" tool anywhere in this spec,
the architecture doc, the tool list, or the code: those functions are driving-safety-critical,
are not exposed for this kind of remote/unattended control by either API in a form this agent
would use, and sit outside the scope this project exists to cover. If a future task asks this
codebase to add Autopilot control, Summon, speed control, or any jailbreak/root/firmware path,
the correct response is to refuse and point back to this section — not to find a workaround via
raw HTTP, an undocumented endpoint, or a third-party unlock. That refusal is encoded in code
comments at the tool-registration boundary (see ARCHITECTURE.md's Tool list) and here.

## User stories (exact text exchanges)

1.
   - Owner: `warm up my car in 15 min`
   - Agent: `Got it. Starting climate at 7:45pm, running until it's warm. Reply CANCEL to cancel.`
   - (at 7:45pm, after re-reading state) Agent: `Climate is on, cabin 61°F and rising.`
2.
   - Owner: `how many miles`
   - Agent: `47,382 miles. Odometer, just checked.`
3.
   - Owner: `is it locked`
   - Agent: `Yes, locked. Last state change 11 min ago.`
4.
   - Owner: `where is it`
   - Agent: `Parked at 1900 Park Ave, Denver, CO. Not moving for 2h 15m.`
5.
   - Owner: `charge to 80`
   - Agent: `Charge limit set to 80%. Currently at 54%, charging, done in about 1h 40m.`
6.
   - Owner: `send me to the airport`
   - Agent: `Sent "Denver International Airport" to your nav. Pull it up on the car screen.`
7.
   - Owner: `open the trunk`
   - Agent: `That needs your PIN first — reply with it to confirm.`
   - Owner: `4471`
   - Agent: `Trunk opened.`
8.
   - Owner: `unlock it`
   - Agent: `That needs your PIN first — reply with it to confirm.`
   - Owner: `wrong`
   - Agent: `That PIN didn't match. Nothing unlocked. Try again or reply CANCEL.`
9.
   - Owner: `honk it, I can't find it in the lot`
   - Agent: `Honked.` (no confirmation needed, no state re-read required — there's no
     persistent state to verify, so the agent confirms on ack from Tessie, not on a guess)
10.
   - Owner: `leave for the office at 8am tomorrow with the cabin warm`
   - Agent: `Got it. Preconditioning will start 8:00am tomorrow to be ready on departure.
     Reply CANCEL to cancel.`
   - (next morning, after re-reading state at trigger time) Agent: `Departure prep started,
     cabin preconditioning. 8:00am as planned.`

## Tool list (name, what it does, gate)

| Tool | Gate |
|---|---|
| `get_vehicle_state` (odometer, battery %, charge state, lock state, location, climate state) | none |
| `climate_on` / `climate_off` | none |
| `set_climate_temp(tempF)` | none |
| `lock` | none |
| `unlock` | **user PIN** |
| `charge_start` / `charge_stop` | none |
| `set_charge_limit(percent)` | none |
| `open_charge_port` / `close_charge_port` | none |
| `open_trunk` / `open_frunk` | **user PIN** |
| `honk_horn` | none |
| `flash_lights` | none |
| `sentry_on` / `sentry_off` | none |
| `vent_windows` / `close_windows` | none |
| `nav_send_destination(address)` | none |
| `set_scheduled_departure(time, preconditionEnabled)` | none, but replies with the planned
  time and "Reply CANCEL to cancel" |
| `schedule_action(tool, args, whenISO)` (internal — used for every "in N minutes" / "at X"
  phrasing, wraps any of the above) | inherits the gate of the wrapped tool; always replies
  with the planned time and "Reply CANCEL to cancel" |

No tool named `autopilot_*`, `fsd_*`, `summon*`, `set_speed*`, or anything that drives the
car exists, is planned, or will be added via this spec. See "What this will never do."

## Channels

- **Telegram** (primary, day 1): grammY bot, long polling. Owner's chat ID allowlisted via
  `ALLOWED_CHAT_IDS`; anyone else's message is ignored, not answered.
- **Twilio SMS** (secondary): inbound webhook (raw `fetch`-based TwiML response, no SDK needed
  for parsing `From`/`Body` form-encoded POST); outbound replies via `fetch` to the Twilio
  Messages API, no SDK. Owner's number allowlisted the same way.
- Both channels resolve to one `Channel` interface so the agent core doesn't know which one
  it's talking over (see ARCHITECTURE.md).

## Scheduling ("in 15 min", "at 8am tomorrow")

- SQLite (`node:sqlite`, built in — no native deps) table `triggers`: id, channel, chat_id,
  tool_name, tool_args (JSON), fire_at (unix ms), status (`pending` / `fired` / `cancelled`),
  created_at, reply_context (what to say back once fired).
- A 10-second poller (`setInterval`, cleared in `finally` by tests) selects
  `status='pending' AND fire_at <= now`, marks them `fired` before executing (so a crash mid-poll
  doesn't double-fire), runs the tool, re-reads vehicle state, and sends the confirmation through
  the right channel.
- `CANCEL` (never `STOP` — that's the Twilio carrier opt-out keyword and must never be reused)
  from the same chat/number cancels the most recent `pending` trigger for that chat. `X` is
  accepted as a terse alias in the SMS channel only, where users are used to it.

## Config / env vars

| Var | Purpose |
|---|---|
| `TESSIE_TOKEN` | Tessie API bearer token |
| `TESSIE_VIN` | the one vehicle this instance controls |
| `ANTHROPIC_API_KEY` | Claude (model `claude-sonnet-5`), tool use |
| `TELEGRAM_BOT_TOKEN` | grammY bot token |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth, also used to verify inbound webhook signature |
| `TWILIO_FROM_NUMBER` | the number texts go out from |
| `USER_PIN` | PIN required for `unlock`, `open_trunk`, `open_frunk` |
| `ALLOWED_CHAT_IDS` | comma-separated Telegram chat IDs and/or E.164 phone numbers allowed to command the car |

## Fake Tessie server for tests

`test/fakeTessie.ts` — a tiny Hono app standing in for `tessie.com`'s API surface: in-memory
vehicle state (lock, climate, charge %, charge limit, location, odometer, sentry, windows,
trunk/frunk), endpoints matching Tessie's real paths for every tool above, state actually
mutates on command (lock really flips to locked) so tests can assert the agent's re-read
reflects the change, and a `/command/<vin>/wake` no-op since Tessie handles that itself.
`VehicleAdapter` tests point `TESSIE_BASE_URL` (test-only override, not a prod env var) at this
fake server's local port instead of the real API. Server is started per test file and its
listener closed in a `finally` so `node --test` exits cleanly.

## Note (2026-10-27, after Codex review)
A native Tesla scheduled departure is cancelled by texting "cancel scheduled departure" (the `cancel_scheduled_departure` tool), not by CANCEL. CANCEL only clears this app's own pending triggers. Any older wording above that says "Reply CANCEL" for scheduled departure is superseded by this note.
