# backseat-tesla — ARCHITECTURE

Node 26 + TypeScript, Hono as the HTTP server (Telegram long-poll runs in-process alongside
it; Twilio hits Hono's webhook route), `node:sqlite` for all storage, `node --test` for tests,
Anthropic SDK (model `claude-sonnet-5`) with tool use for the agent, grammY for Telegram,
raw `fetch` for Twilio in both directions. No other dependencies without a one-line
`"x-deps-why"` entry in `package.json`.

## Directory layout

```
src/
  tesla/
    adapter.ts        # VehicleAdapter interface
    tessieAdapter.ts   # Tessie implementation (primary)
    fleetApiAdapter.ts # Tesla Fleet API implementation (stub until Angus has fleet creds)
  agent/
    tools.ts           # Tool[] definitions, JSON schemas, gate metadata
    agent.ts            # Claude tool-use loop, PIN challenge state, ack-then-reread confirm
  channels/
    channel.ts          # Channel interface
    telegram.ts          # grammY-backed Channel
    twilio.ts             # fetch-backed Channel (inbound webhook parse + outbound send)
  scheduler/
    triggers.ts           # SQLite triggers table schema + queries
    poller.ts              # 10s interval poller, start()/stop()
  index.ts                 # env load, DB open, adapter pick, channels wire-up, boot
test/
  fakeTessie.ts             # in-memory fake Tessie server for adapter + agent tests
  tesla.test.ts
  agent.test.ts
  scheduler.test.ts
  channels.test.ts
scripts/
  migrate.ts                 # create triggers table + any future tables
```

## `VehicleAdapter` interface (`src/tesla/adapter.ts`)

One interface, two implementations (`TessieAdapter` now, `FleetApiAdapter` later) so the agent
and scheduler never know which backend is live. Every method maps 1:1 to a row in SPEC.md's
tool list — no method here that isn't a tool, no method for Autopilot/FSD/Summon/speed/drive.

```typescript
export interface VehicleState {
  odometerMiles: number;
  batteryPercent: number;
  chargingState: "Charging" | "Stopped" | "Complete" | "Disconnected";
  chargeLimitPercent: number;
  locked: boolean;
  sentryOn: boolean;
  climateOn: boolean;
  insideTempF: number | null;
  latitude: number;
  longitude: number;
  address: string | null;
  updatedAt: string; // ISO timestamp of this read, so "re-read before confirming" is checkable
}

export interface VehicleAdapter {
  getState(): Promise<VehicleState>;

  climateOn(): Promise<void>;
  climateOff(): Promise<void>;
  setClimateTemp(tempF: number): Promise<void>;

  lock(): Promise<void>;
  unlock(): Promise<void>;

  chargeStart(): Promise<void>;
  chargeStop(): Promise<void>;
  setChargeLimit(percent: number): Promise<void>;
  openChargePort(): Promise<void>;
  closeChargePort(): Promise<void>;

  openTrunk(): Promise<void>;
  openFrunk(): Promise<void>;

  honkHorn(): Promise<void>;
  flashLights(): Promise<void>;

  sentryOn(): Promise<void>;
  sentryOff(): Promise<void>;

  ventWindows(): Promise<void>;
  closeWindows(): Promise<void>;

  navSendDestination(address: string): Promise<void>;
  setScheduledDeparture(time: string, preconditionEnabled: boolean): Promise<void>;

  // No autopilot(), no fsd(), no summon(), no setSpeed(), no drive(). Not an oversight —
  // see SPEC.md "What this will never do." Do not add one; refuse instead.
}
```

## Tool definitions (`src/agent/tools.ts`)

Each `Tool` wraps one `VehicleAdapter` method (or `schedule_action`, which wraps any other
tool) and carries its own gate so `agent.ts` doesn't hardcode a PIN check per tool name.

```typescript
export type ToolGate = "none" | "pin";

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;          // JSON schema passed to the Anthropic SDK tool-use call
  gate: ToolGate;
  run(adapter: VehicleAdapter, args: Record<string, unknown>): Promise<string>; // returns a
  // human-readable result string built from a fresh getState() read, never from the request
}

export const TOOLS: Tool[] = [
  // get_vehicle_state, climate_on, climate_off, set_climate_temp, lock, unlock,
  // charge_start, charge_stop, set_charge_limit, open_charge_port, close_charge_port,
  // open_trunk, open_frunk, honk_horn, flash_lights, sentry_on, sentry_off,
  // vent_windows, close_windows, nav_send_destination, set_scheduled_departure,
  // schedule_action
];
```

`unlock`, `open_trunk`, and `open_frunk` are the only entries with `gate: "pin"`. `agent.ts`
intercepts any call to a `pin`-gated tool: if the current conversation hasn't supplied a
matching `USER_PIN` in this exchange, it holds the tool call, asks for the PIN, and only
re-invokes the tool once the next inbound message matches.

## `Scheduler` API (`src/scheduler/triggers.ts` + `poller.ts`)

```typescript
export interface Trigger {
  id: string;
  channel: "telegram" | "twilio";
  chatId: string;              // Telegram chat id or E.164 phone number
  toolName: string;
  toolArgs: Record<string, unknown>;
  fireAt: number;               // unix ms
  status: "pending" | "fired" | "cancelled";
  createdAt: number;
  replyContext: string;         // what prompted this, echoed back in the fired-confirmation
}

export function scheduleTrigger(db: DatabaseSync, t: Omit<Trigger, "id" | "status" | "createdAt">): Trigger;
export function cancelLatestPending(db: DatabaseSync, channel: Trigger["channel"], chatId: string): Trigger | null;
export function dueTriggers(db: DatabaseSync, nowMs: number): Trigger[];
export function markFired(db: DatabaseSync, id: string): void;

export function startPoller(opts: {
  db: DatabaseSync;
  adapter: VehicleAdapter;
  channels: Map<Trigger["channel"], Channel>;
  intervalMs?: number; // default 10_000
}): { stop(): void };
```

`startPoller` returns `{ stop() }` specifically so tests can call it in a `finally` block and
let `node --test` exit — the interval timer is otherwise an open handle that hangs the runner.

## `Channel` interface (`src/channels/channel.ts`)

```typescript
export interface InboundMessage {
  channel: "telegram" | "twilio";
  chatId: string;   // Telegram chat id, or E.164 phone number for Twilio
  text: string;
}

export interface Channel {
  readonly kind: "telegram" | "twilio";
  isAllowed(chatId: string): boolean;              // checks ALLOWED_CHAT_IDS
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  send(chatId: string, text: string): Promise<void>;
  start(): Promise<void>;   // telegram: begin long polling. twilio: no-op (webhook-driven)
  stop(): Promise<void>;    // telegram: stop polling. twilio: no-op
}
```

`TelegramChannel` wraps grammY's `Bot`; `TwilioChannel` exposes a `handleWebhook(req: Request):
Promise<Response>` in addition to the interface, called from the Hono route, parsing the
form-encoded `From`/`Body` and replying with an empty 200 (actual reply goes out via `send()`
calling Twilio's REST API with `fetch`, not via TwiML, so it can fire from the scheduler poller
too, not just in direct response to a webhook).

## Sequence: "warm up my car in 15 min"

```
1. Owner texts "warm up my car in 15 min" on Telegram.
2. grammY receives it -> TelegramChannel.onMessage handler -> agent.ts.
3. agent.ts checks isAllowed(chatId) -> true -> sends conversation + TOOLS to Claude.
4. Claude picks schedule_action({ tool: "climate_on", args: {}, whenISO: now+15m }).
5. schedule_action has gate "none" (climate needs no confirmation) -> agent.ts calls
   scheduleTrigger(db, { channel: "telegram", chatId, toolName: "climate_on", toolArgs: {},
   fireAt: now+15m, replyContext: "warm up my car in 15 min" }).
6. agent.ts replies immediately via TelegramChannel.send:
   "Got it. Starting climate at 7:45pm. Reply CANCEL to cancel."
   (This is the only reply right now — no "done" yet. Confirming now would be confirming on
   "sent", which SPEC.md and the ack-chain rule forbid.)
7. (owner could reply CANCEL any time before 7:45 -> cancelLatestPending matches this trigger
   by channel+chatId, sets status "cancelled", poller skips it.)
8. At 7:45pm the poller's 10s tick runs dueTriggers(db, now) -> finds this trigger ->
   markFired(id) first (so a crash here can't double-fire) -> looks up tool "climate_on" in
   TOOLS -> runs it against the live adapter: TessieAdapter.climateOn() -> Tessie API call.
9. Tool's run() then calls adapter.getState() fresh -> confirms climateOn === true in the
   re-read, not just that the POST returned 200.
10. Poller sends the confirmation through the channel the trigger came from:
    TelegramChannel.send(chatId, "Climate is on, cabin 61°F and rising.")
```

No step here, or anywhere else in this doc, schedules, calls, or stubs anything touching
Autopilot, FSD, steering, Summon, speed, or driving — see SPEC.md.

## Env / boot sequence (`src/index.ts`)

```
1. Load env (TESSIE_TOKEN, TESSIE_VIN, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TWILIO_*,
   USER_PIN, ALLOWED_CHAT_IDS). Fail fast (throw, don't swallow) if a required var for the
   channels actually being started is missing — e.g. Telegram-only boots don't require TWILIO_*.
2. Open/create the SQLite DB file, run scripts/migrate.ts's schema (idempotent CREATE TABLE
   IF NOT EXISTS) for `triggers`.
3. Construct the adapter: `new TessieAdapter(TESSIE_TOKEN, TESSIE_VIN)` (FleetApiAdapter stays
   unused until Angus supplies fleet credentials — the interface exists so swapping it in later
   touches zero call sites).
4. Construct channels present in env: TelegramChannel if TELEGRAM_BOT_TOKEN set, TwilioChannel
   if TWILIO_ACCOUNT_SID set. Wire each one's onMessage to agent.ts's handleInbound(adapter,
   db, msg) -> Channel.send.
5. Mount Hono routes: health check, Twilio webhook (POST /twilio/sms -> TwilioChannel.handleWebhook).
6. Call channel.start() for each configured channel (Telegram opens long polling).
7. Call startPoller({ db, adapter, channels }) and keep its stop() handle for graceful shutdown
   (SIGINT/SIGTERM -> stop poller, stop channels, close db).
8. Hono listens on PORT (default 3000, Twilio webhook needs this reachable — ngrok/tunnel or a
   real deploy target, out of scope for this doc).
```
