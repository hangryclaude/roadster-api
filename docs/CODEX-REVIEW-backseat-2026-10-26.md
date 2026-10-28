The core safety gates are not reliable yet: scheduling bypasses PIN checks, nine tools confirm without reading state, and PINs leak into conversation history and error logs.

Verified on Node 26.10.0: **43 tests pass**, `tsc --noEmit` passes, and the scripted E2E passes. Additional local reproductions confirmed the failures below. These used synthetic credentials, fake adapters, and scripted model responses; no live vehicle commands were sent. No files were changed.

**1. Security**

- **High — Telegram errors expose the bot token and inbound PIN in logs.** [src/channels/telegram.ts:36](/Users/angus/dev/backseat-tesla/src/channels/telegram.ts:36) discards the polling promise without installing an error handler; the handler also lets command errors propagate at [line 25](/Users/angus/dev/backseat-tesla/src/channels/telegram.ts:25). **Scenario:** a vehicle request throws while processing the owner’s PIN; grammY’s default handler throws a `BotError`, and Node’s unhandled rejection output includes the context’s bot token and message text. Reproduced locally; the process exited with code 1.

- **High — Correct PINs are stored in plaintext and sent to Anthropic on later requests.** [src/agent/agent.ts:170](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:170) saves the successful PIN message through [src/agent/memory.ts:32](/Users/angus/dev/backseat-tesla/src/agent/memory.ts:32); [agent.ts:102](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:102) subsequently includes it in model history. **Scenario:** after unlocking once, the owner asks for battery status; that model request contains the actual PIN. Reproduced. There is also no output redaction preventing the model from echoing that history.

- **Medium — PIN guessing has no attempt limit or expiry.** [src/agent/agent.ts:161](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:161). **Scenario:** someone with access to an allowlisted messaging account initiates an unlock and repeatedly guesses PINs; failed attempts leave the challenge active indefinitely. The configured PIN comes directly from plaintext `USER_PIN` at [src/index.ts:72](/Users/angus/dev/backseat-tesla/src/index.ts:72), and comparison uses ordinary `===` at [agent.ts:163](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:163), with neither hashing nor timing-safe comparison. I did not establish a remotely exploitable timing attack.

Webhook authentication itself is present where applicable:

- **Telegram has no webhook endpoint.** It uses grammY long polling and checks the chat allowlist at [src/channels/telegram.ts:24](/Users/angus/dev/backseat-tesla/src/channels/telegram.ts:24), so a webhook secret-token check is inapplicable.
- **Twilio validates `X-Twilio-Signature` before dispatch** at [src/channels/twilio.ts:88](/Users/angus/dev/backseat-tesla/src/channels/twilio.ts:88), then checks the sender allowlist. Missing or invalid signatures are rejected. I found no unsigned POST bypass; replay handling is defective, as described below.
- I found no hardcoded production credentials. This checkout has no commits or tracked files, so there is no committed history to inspect. Fleet is an unused throwing stub. The confirmed credential leaks are the Telegram error context and PIN history above.

**2. Safety gates**

- **High — Scheduled unlock, trunk, and frunk actions bypass PIN verification entirely.** [src/agent/tools.ts:305](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:305) assigns `schedule_action` its own confirmation gate without inheriting the wrapped tool’s PIN gate; [src/scheduler/poller.ts:71](/Users/angus/dev/backseat-tesla/src/scheduler/poller.ts:71) executes `tool.run()` directly. **Scenario:** “unlock in one minute” produces `schedule_action({tool:"unlock",…})`; the schedule is accepted and the poller unlocks without any PIN exchange. Reproduced. The same execution path covers both trunks.

- **High — Nine tools report success without any state read.** Each implementation below returns its confirmation immediately after the adapter call. **Scenario:** the request resolves but the physical change has not happened; the owner receives the listed success assertion. All nine were reproduced with zero `getState()` calls, and the poller sends these strings directly.

  | Tool | Location | Unverified assertion |
  |---|---|---|
  | `set_climate_temp` | [tools.ts:86](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:86) | Target temperature set |
  | `open_charge_port` | [tools.ts:157](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:157) | Port opened |
  | `close_charge_port` | [tools.ts:167](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:167) | Port closed |
  | `open_trunk` | [tools.ts:177](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:177) | Trunk opened |
  | `open_frunk` | [tools.ts:187](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:187) | Frunk opened |
  | `vent_windows` | [tools.ts:239](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:239) | Windows vented |
  | `close_windows` | [tools.ts:249](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:249) | Windows closed |
  | `nav_send_destination` | [tools.ts:263](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:263) | Destination sent |
  | `set_scheduled_departure` | [tools.ts:282](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:282) | Departure configuration accepted |

  Honk and flash are transient actions, so their acknowledgement-based replies are not included in this finding.

- **High — Model text can override a failed verification.** [src/agent/agent.ts:118](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:118) returns the model’s final text unchanged. **Scenario:** the lock tool reports “not reading locked yet,” but the next model response says “Locked.”; that success reply is delivered unchanged. Reproduced with scripted model output and a vehicle that remained unlocked. The system prompt expresses the rule, but the harness does not enforce it.

- **High — Cached or missing telemetry can masquerade as verified state.** [src/tesla/tessieAdapter.ts:63](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:63) substitutes `locked:false` when lock telemetry is absent, while [line 71](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:71) stamps every response with the current time instead of preserving vehicle timestamps. **Scenario:** an unlock followed by a partial state response returns “Unlocked.” despite having no lock observation; alternatively, old cached “locked” data can falsely confirm a lock. The state request at [line 108](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:108) also leaves caching enabled; Tessie documents cached reads by default and a real-time option for legacy Model S/X. [Tessie state documentation](https://developer.tessie.com/reference/get-vehicle)

- **High — Native scheduled departure advertises cancellation that does not exist.** [src/agent/tools.ts:285](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:285) configures the vehicle directly and promises “Reply CANCEL to cancel,” but creates no trigger; [src/agent/agent.ts:154](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:154) only cancels SQLite triggers. **Scenario:** after native departure configuration succeeds, `CANCEL` returns “Nothing pending to cancel” and leaves that configuration active. Reproduced with a fake adapter. Its `gate:"none"` also lets the model rewrite or omit the required planned-time/CANCEL wording.

- **Medium — `STOP` reaches unrestricted agent processing instead of remaining a reserved carrier keyword.** [src/channels/twilio.ts:94](/Users/angus/dev/backseat-tesla/src/channels/twilio.ts:94) forwards it, and [src/agent/agent.ts:186](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:186) invokes the normal model loop. **Scenario:** an inbound `STOP` produces a model-selected `charge_stop` command and an application reply; reproduced with scripted output. There is **no explicit `STOP` cancellation alias**, but neither ingress nor the agent prevents application interpretation.

- **Low — `X` cancels Telegram schedules despite being specified as SMS-only.** [src/agent/agent.ts:152](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:152). **Scenario:** a Telegram `X` cancels the latest pending action. Reproduced.

I found **no reachable Autopilot, FSD, Summon, steering, speed-control, driving, jailbreak, root, or firmware implementation**. Tool lookup remains restricted to `TOOLS`; scheduled tool names cannot become arbitrary Tessie endpoint names.

**3. Correctness bugs**

- **High — Several adapter calls do not match Tessie’s documented contract.** The fake server duplicates these mistakes, allowing tests to pass.

  | Location | Defect and concrete failure |
  |---|---|
  | [tessieAdapter.ts:126](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:126) | Sends `driver_temp`/`passenger_temp`; Tessie requires `temperature`. Setting cabin temperature omits the required parameter. [Documentation](https://developer.tessie.com/reference/set-temperature) |
  | [tessieAdapter.ts:160](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:160) | Uses `open_trunk`/`open_frunk`; documented commands are `activate_rear_trunk`/`activate_front_trunk`. Both trunk requests target the wrong routes. [Rear](https://developer.tessie.com/reference/rear-trunk), [front](https://developer.tessie.com/reference/front-trunk) |
  | [tessieAdapter.ts:195](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:195) | Sends navigation to `/{vin}/share?address=…`; documented contract is `/{vin}/command/share?value=…`. Destination delivery fails. [Documentation](https://developer.tessie.com/reference/share) |
  | [tessieAdapter.ts:201](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:201) | Uses `schedule_departure`, sends an ISO string instead of minutes past local midnight, and omits required `enable`. Native departure configuration fails. [Documentation](https://developer.tessie.com/reference/set-scheduled-departure) |

- **High — HTTP success is treated as command success even when `result:false`.** [src/tesla/tessieAdapter.ts:98](/Users/angus/dev/backseat-tesla/src/tesla/tessieAdapter.ts:98) parses the response, but every command method discards its result. **Scenario:** Tessie returns HTTP 200 with `{result:false}` for honk; the adapter resolves and the tool says “Honked.” Reproduced. Tessie defines `result` as whether the command succeeded. [Command response documentation](https://developer.tessie.com/reference/flash-lights)

- **High — Scheduled actions run concurrently and can finish in the opposite order.** [src/scheduler/poller.ts:86](/Users/angus/dev/backseat-tesla/src/scheduler/poller.ts:86) launches dispatches without awaiting prior work. **Scenario:** an earlier climate-on request is slow; a later climate-off completes first, then the delayed on completes, leaving climate on. Reproduced across successive ticks.

- **High — Twilio retries or signed replays execute the same message repeatedly.** [src/channels/twilio.ts:96](/Users/angus/dev/backseat-tesla/src/channels/twilio.ts:96) dispatches without deduplicating `MessageSid`. **Scenario:** delivery is retried after slow processing or a lost response; the same SMS creates a second schedule or repeats a command. Repeated identical signed requests dispatched twice locally. Signature validation does not provide idempotency.

- **Medium — Signature validation rejects legitimate traffic behind TLS termination.** [src/channels/twilio.ts:89](/Users/angus/dev/backseat-tesla/src/channels/twilio.ts:89) signs `req.url`, while [src/index.ts:153](/Users/angus/dev/backseat-tesla/src/index.ts:153) serves plain HTTP. **Scenario:** an HTTPS tunnel/proxy forwards to Node over HTTP; Twilio signed the public HTTPS URL, but Hono supplies an HTTP URL, causing 403. Reproduced even with `X-Forwarded-Proto:https`. Twilio requires the configured public URL in the signature calculation. [Signature documentation](https://www.twilio.com/docs/usage/security)

- **Medium — Relative scheduling has no authoritative clock or timezone and accepts past dates.** [src/agent/agent.ts:109](/Users/angus/dev/backseat-tesla/src/agent/agent.ts:109) provides neither current time nor owner timezone; [src/agent/tools.ts:310](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:310) trusts `Date.parse()` without future-time validation. **Scenario:** “in 15 minutes” yields an old ISO timestamp; the app confirms it and executes on the next poll. Past-date acceptance was reproduced.

- **Medium — Invalid scheduled tool names are accepted, then silently discarded.** [src/agent/tools.ts:307](/Users/angus/dev/backseat-tesla/src/agent/tools.ts:307) stores an unchecked name; [src/scheduler/poller.ts:70](/Users/angus/dev/backseat-tesla/src/scheduler/poller.ts:70) returns after the trigger has already been marked fired. **Scenario:** the model emits `climate_start` instead of `climate_on`; the owner receives a schedule confirmation, but nothing runs and no failure message follows.

- **Medium — Scheduled execution failures are invisible to the owner.** [src/scheduler/poller.ts:89](/Users/angus/dev/backseat-tesla/src/scheduler/poller.ts:89) only logs dispatch failures. **Scenario:** Tessie is unavailable when preconditioning is due; the trigger remains `fired`, and the owner receives neither execution nor failure notification.

**4. Missing tests**

- **High — PIN coverage misses the scheduled bypass and secret retention.** [test/agent/agent.test.ts:45](/Users/angus/dev/backseat-tesla/test/agent/agent.test.ts:45) covers immediate unlock, while [line 93](/Users/angus/dev/backseat-tesla/test/agent/agent.test.ts:93) schedules only climate. There are no scheduled unlock/trunk/frunk gate tests, successful frunk challenge tests, or assertions excluding PINs from SQLite, model requests, output, and logs.

- **High — The state-before-success tests do not enforce the rule.** [test/agent/agent.test.ts:26](/Users/angus/dev/backseat-tesla/test/agent/agent.test.ts:26) checks mutated state rather than read ordering or failed verification. [test/scheduler.test.ts:156](/Users/angus/dev/backseat-tesla/test/scheduler.test.ts:156) tests `runThenVerify`, but production tool execution never uses that helper. The nine unverified tools and misleading final model text therefore remain green.

- **High — Adapter tests validate a matching fake rather than the external contract.** [test/tesla/tessieAdapter.test.ts:70](/Users/angus/dev/backseat-tesla/test/tesla/tessieAdapter.test.ts:70), [line 103](/Users/angus/dev/backseat-tesla/test/tesla/tessieAdapter.test.ts:103), [line 139](/Users/angus/dev/backseat-tesla/test/tesla/tessieAdapter.test.ts:139), and [line 149](/Users/angus/dev/backseat-tesla/test/tesla/tessieAdapter.test.ts:149) accept the incorrect temperature, trunk, navigation, and departure contracts. They also lack HTTP-200 command failures and stale telemetry cases; [line 169](/Users/angus/dev/backseat-tesla/test/tesla/tessieAdapter.test.ts:169) explicitly endorses missing lock telemetry becoming unlocked.

- **High — Scheduler tests never exercise real dispatch.** [test/scheduler.test.ts:139](/Users/angus/dev/backseat-tesla/test/scheduler.test.ts:139) starts the poller with an empty channel map and no scheduled action. It cannot detect overlapping commands, skipped PIN gates, dispatch failures, or missing owner notifications.

- **Medium — Channel tests omit ingress lifecycle and keyword behavior.** [test/channels.test.ts:57](/Users/angus/dev/backseat-tesla/test/channels.test.ts:57) constructs a direct HTTPS `Request`, missing the proxy signature failure and duplicate delivery; Telegram coverage at [line 113](/Users/angus/dev/backseat-tesla/test/channels.test.ts:113) checks only `isAllowed()`. There are no `STOP` isolation, SMS-only `X`, Telegram handler-error, or native-departure cancellation tests.