# Free Tessie — design brief

Self-hosted Tessie replacement on Tesla's official Fleet API, added to `backseat-tesla`.
Research date 2026-10-27. Full fact list with confidence tags and sources: `RESEARCH.md`
in this same directory.

## 1. Decision summary

- Build a standalone Hono/SQLite server, **`freetessie`**, that talks to Tesla's official
  Fleet API with the owner's own developer-app credentials and re-exposes a **Tessie-shaped
  REST surface** (`/{vin}/state`, `/{vin}/command/{name}`, bearer auth). `TessieAdapter`
  (`src/tesla/tessieAdapter.ts`) needs **zero code changes** — point `TESSIE_BASE_URL` at
  `freetessie` and `TESSIE_TOKEN` at a key it mints. That's the whole integration surface.
- Signing: run Tesla's own open-source Go binary `tesla-http-proxy`
  (`teslamotors/vehicle-command`, Apache 2.0) as a local sidecar. Do **not** reimplement
  the Vehicle Command Protocol's crypto in TypeScript — no maintained package does this,
  and the one native TS proof-of-concept only ships `lock`.
- Data path: Fleet Telemetry (push) is the always-on data source; `vehicle_data` (poll) is
  called only on-demand — once per command, for the post-action verification read this
  codebase's SPEC.md already requires, never on a timer.
- Hosting at $0: GitHub Pages (`*.github.io` + `.nojekyll`) serves only the public-key file.
  The bot + telemetry receiver + OAuth callback run on Render's free tier, or — the better
  option — a $10.46/yr Cloudflare-registered domain tunnelled to Angus's always-on Mac via a
  named `cloudflared` tunnel (one process, no split-hosting, no cold starts, directly
  validated by a real developer's working setup).
- One new local SQLite schema (`drives`, `charges`, `idles`, `fleet_tokens`, `api_keys`)
  derived from the telemetry stream, mirroring what Tessie itself keeps.
- Hard scope carried over unchanged from this repo's `adapter.ts`/SPEC.md: no
  Autopilot/FSD/Summon/speed/drive, no jailbreak/root/firmware, no hardware. `freetessie`'s
  command router implements exactly the 21 Tessie command names `TessieAdapter` already
  calls — nothing more.
- Cost: on Angus's actual usage pattern (SMS-triggered reads/commands + telemetry
  streaming while driving), this is $0/month, comfortably inside Tesla's $10/month
  per-account credit. A naive 60-second `vehicle_data` poll loop is the one design that
  blows the budget (~$28.80/mo) — forbidden by architecture, not just by convention.
- Exactly one step in the whole build needs Angus's own hands and can't be scripted: tapping
  the virtual-key pairing link from the Tesla app on his phone, with the car online. Also
  his-only: the account/app registration and the end-user OAuth consent (see §2).

## 2. Setup flow the owner performs

Numbered in the order they actually need to happen. **[HUMAN-ONLY]** marks a step nobody
and nothing else can do for him — not Claude, not a script. Everything else here can be run
by the agent once Angus has supplied the preceding human-only inputs.

1. **[HUMAN-ONLY]** Confirm his Tesla Account has a verified email and MFA enabled (most
   accounts already do).
2. **[HUMAN-ONLY]** Register a developer app at `developer.tesla.com/request`: app name,
   description, purpose of use, and the "legal business details" field (community reports
   suggest entering himself/individual works; unconfirmed from a primary source — flag this
   as a possible snag). No credit card needed at this step.
3. Generate the secp256r1 (prime256v1) EC keypair (`openssl ecparam -name prime256v1
   -genkey -noout` / `openssl ec -pubout`) — scriptable, no human needed.
4. Host the public key at `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
   on whichever domain was chosen in step 5 — scriptable (commit to GitHub Pages, or serve
   it from the `freetessie` process itself if using the Cloudflare Tunnel route).
5. **[HUMAN-ONLY]** Decide and register the domain: pick GitHub Pages (free, zero setup) or
   buy the ~$10/yr Cloudflare-registered domain for the tunnel route, then paste that domain
   into the developer app's "Allowed Origin" field and the OAuth "Allowed Redirect URI"
   field on `developer.tesla.com`'s dashboard — this is a web-UI form, not an API call.
6. Mint a partner (`client_credentials`) token and call `POST /api/1/partner_accounts` to
   register the domain/key with Tesla — one-time, scriptable (`scripts/register-partner.ts`).
7. **[HUMAN-ONLY]** Complete the end-user OAuth consent: open the `/authorize` URL in a
   browser, log into **his own** Tesla account, approve the requested scopes. Only the
   vehicle's owner can grant this — nobody can click "approve" on his behalf.
8. **[HUMAN-ONLY, physical]** Open the virtual-key pairing link
   (`https://tesla.com/_ak/<domain>`) **from the Tesla app on his phone**, with the car
   online and the app at version ≥4.27.3. Tesla's docs state plainly that it cannot add
   this key remotely to a normally-purchased car — a person with the app and vehicle access
   must tap "approve." This is the one step with no scripted alternative, full stop.
9. **[HUMAN-ONLY, if using the tunnel route]** Run `cloudflared tunnel login` once (needs
   his own Cloudflare account) and create the named tunnel.
10. Everything else — code, SQLite schema/migrations, the Fleet Telemetry config push,
    server boot, local API-key minting, tests — is scriptable with no further human action.

## 3. Architecture

### Modules / files to add (under `src/`)

```
src/
  freetessie/
    server.ts            # Hono app — the Tessie-compatible REST surface, its own process
                          # and port (separate from backseat-tesla's own Hono app, since
                          # Tessie's real paths are rooted at "/" with no prefix)
    db.ts                 # SQLite schema: fleet_tokens, drives, charges, idles,
                          # vehicle_state_cache, api_keys
    fleetAuth.ts          # partner-token mint, third-party authorize+token exchange,
                          # refresh-with-rotation, dead-token detection
    tokenStore.ts         # single-row persisted OAuth token state (single owner, single car)
    signingProxy.ts       # thin client for the locally-running tesla-http-proxy sidecar
    commandMap.ts         # Tessie command name -> Fleet API call + field-name translation
                          # table (see route table below)
    telemetryIngest.ts    # Fleet Telemetry WebSocket receiver -> drives/charges/idles
                          # session-detection -> SQLite
    apiKeys.ts            # mint/verify the local bearer "API key" (hash-stored, matches
                          # agent.ts's existing hashPin/timingSafeEqual idiom)
    routes/
      state.ts            # GET /{vin}/state, /battery, /location, /status
      history.ts          # GET /{vin}/drives, /charges, /idles
      commands.ts          # POST /{vin}/command/{name}, POST /{vin}/wake
      keys.ts               # GET /.well-known/appspecific/com.tesla.3p.public-key.pem
                             # (only if this process also owns the public domain)
scripts/
  register-partner.ts    # one-time POST /api/1/partner_accounts
  fleet-authorize.ts      # one-time interactive OAuth consent helper (opens the
                           # /authorize URL, catches the redirect, exchanges the code)
  mint-api-key.ts          # prints a new local bearer key once, stores only its hash
docs/
  FREETESSIE_SETUP.md      # the human steps from §2, written out for Angus to follow
```

This sits **alongside**, not instead of, the `fleetApiAdapter.ts` stub ARCHITECTURE.md
already names — but note the Tessie-compatible-server approach makes that stub largely
unnecessary: `TessieAdapter` already takes `baseUrl` as a constructor argument (and reads
`TESSIE_BASE_URL` from env), so pointing it at `freetessie` instead of `api.tessie.com` is a
config change, not a new adapter class. Recommend **not** writing `fleetApiAdapter.ts` as a
second `VehicleAdapter` implementation — it would duplicate logic that already lives in
`freetessie`'s command-mapping layer for no benefit.

### Tessie-compatible route table (path → Fleet API call)

| Tessie path | Fleet API call | Notes |
|---|---|---|
| `GET /{vin}/state` (default, cached) | served from local SQLite `vehicle_state_cache`, kept warm by the telemetry ingester | avoids billing a `vehicle_data` call on every status check |
| `GET /{vin}/state?use_cache=false` | `GET .../vehicles/{vin}/vehicle_data` (live) | the only path that hits a live, billable read — used for post-command verification |
| `GET /{vin}/battery` | subset of the above (cached or live) | |
| `GET /{vin}/location` | `drive_state` from cache; reverse-geocode via Nominatim/OSM (free, 1 req/sec, needs a `User-Agent`) instead of Tessie's undisclosed paid provider | |
| `GET /{vin}/drives`, `/{vin}/charges`, `/{vin}/idles` | derived locally from the telemetry stream — no Fleet API equivalent exists | session-detection logic is new work, see §5 |
| `GET /{vin}/status` | vehicle `state` field (online/asleep/offline) + telemetry connectivity | |
| `GET /vehicles` | `GET /api/1/vehicles` | near-passthrough |
| `POST /{vin}/wake` | `POST .../vehicles/{vin}/wake_up` | **unsigned**, passthrough |
| `POST /{vin}/command/lock`, `unlock`, `honk`, `flash`, `open_charge_port`, `close_charge_port`, `start_charging`, `stop_charging` | same-named signed command via sidecar, no body | |
| `POST /{vin}/command/start_climate`, `stop_climate` | signed, no body | |
| `POST /{vin}/command/set_temperatures` (Tessie: `{temperature}` single Celsius value) | signed `set_temps {driver_temp, passenger_temp}` | split the one value to both fields — Tessie doesn't do driver/passenger split either |
| `POST /{vin}/command/set_charge_limit` (`{percent}`) | signed `set_charge_limit {percent}` | 1:1 |
| `POST /{vin}/command/activate_rear_trunk` | signed `actuate_trunk {which_trunk:"rear"}` | |
| `POST /{vin}/command/activate_front_trunk` | signed `actuate_trunk {which_trunk:"front"}` | |
| `POST /{vin}/command/enable_sentry` / `disable_sentry` | signed `set_sentry_mode {on:true/false}` | |
| `POST /{vin}/command/vent_windows` / `close_windows` | signed `window_control {command:"vent"/"close"}` | |
| `POST /{vin}/command/share` (Tessie: `{value:<address>}`) | **unsigned** `POST .../vehicles/{vin}/command/navigation_request` via plain OAuth bearer, **not** the signing sidecar | Tesla's own vehicle-command source explicitly carves `navigation_request` out of the signed protocol — `ErrCommandUseRESTAPI` |
| `POST /{vin}/command/schedule_departure` (Tessie: `{enable, departure_time, preconditioning_enabled}`) | signed `set_scheduled_departure {enable, departure_time, end_off_peak_time, off_peak_charging_enabled, preconditioning_enabled}` | Fleet API's schema is richer than Tessie's; default the extra fields (`end_off_peak_time` unset/0, `off_peak_charging_enabled: false`) so a straight port doesn't silently need new inputs — **needs a live-call check**: confirm Fleet API still wants minutes-past-midnight like Tessie, not an ISO time, before shipping |

### OAuth + token store design

- **Partner token** (`client_credentials`, for `partner_accounts` registration and nothing
  else): minted on demand, kept only in memory — cheap to re-mint, no long-lived secret
  beyond `client_id`/`client_secret` in env, so nothing to persist.
- **Third-party (owner) token**: one-time interactive flow (`scripts/fleet-authorize.ts`,
  Angus's step 7 in §2) writes `access_token`, `refresh_token`, `expires_at`, `scope` into
  SQLite table `fleet_tokens` — single row, single owner, single car.
- **Refresh**: a guard runs before every Fleet API call; if `expires_at` is within 5 minutes,
  refresh first. On success, persist the **new** `refresh_token` atomically before using the
  new `access_token` — Tesla rotates refresh tokens and gives only a 24-hour grace window on
  the superseded one, so losing a write here mid-crash is a real lockout risk.
- **Dead-token handling**: a password change on the Tesla account kills every token
  instantly with no workaround (confirmed by Tesla's own maintainers). On a `401
  login_required` from a refresh attempt, mark the row dead in SQLite and push a clear
  Telegram alert ("Tesla auth needs re-connecting — reply with the new code") instead of
  retrying forever.
- **At rest**: the SQLite file holds the refresh token in plaintext — acceptable for this
  single-user hobby scope (matches the project's existing posture: no KMS, no secrets
  manager), but flag it in the setup docs and keep normal file permissions on the DB path.

### Key-pairing flow

Generate the secp256r1 keypair once (`openssl`); serve only the **public** half at the fixed
well-known path, with the correct content-type, no redirect. The **private** key lives as a
local file referenced by `signingProxy.ts` via an env var path — never logged, never
committed (add it to `.gitignore` explicitly). Register the domain/key with Tesla via
`POST /api/1/partner_accounts` (one-time script). The actual vehicle pairing — opening
`tesla.com/_ak/<domain>` from the Tesla app with the car online — is Angus's step 8 in §2
and has no automatable alternative.

### Command-signing decision: Tesla's own Go proxy sidecar, not native TS

**Decision**: run `tesla-http-proxy` (from `teslamotors/vehicle-command`, Apache 2.0,
build with the already-installed `go 1.26`) as a local child process bound to loopback only.
`freetessie`'s `signingProxy.ts` forwards signed commands to it over
`https://127.0.0.1:<port>/api/1/vehicles/{vin}/command/{name}` — the exact same REST shape
Fleet API itself uses, so there's no interface mismatch to absorb.

**Reason this beats reimplementing signing in TypeScript**:
- No maintained npm package implements the Vehicle Command Protocol's ECDH+AES-GCM+VCSEC
  framing end-to-end. `teslajs` is dead and pre-dates signing entirely; `@teslemetry/api`
  and `tesdk` are clients of either Teslemetry's paid relay or Tesla's own proxy — not
  native signers.
- The one real native TS/WebCrypto attempt, `Oceanswave/tesla-mcp` (MIT), only implements
  `lock` and its own README calls it an "owner-only MVP," explicitly listing unlock, climate,
  trunk/frunk/windows, and HomeLink as **not implemented**. Porting the rest is a
  multi-week cryptography project with real correctness risk (wrong byte order silently
  bricking a command, not failing loudly).
- Every other project in this ecosystem that supports post-2023 vehicles (Home Assistant's
  Tesla Fleet integration, TeslaMate, the community HTTP-proxy add-ons) handles signing
  exactly this way — by running Tesla's own binary, not by reimplementing it. That's a
  strong signal this is the actually-supported path, not a shortcut.
- The sidecar never needs public exposure — `freetessie` is its only caller — so it adds no
  new attack surface beyond a loopback TLS pair ("snakeoil" cert is fine here).

### Polling/streaming strategy and its cost math

**Rule**: no `setInterval`/timer-driven `vehicle_data` poll, anywhere, ever. This is the one
design choice that single-handedly determines whether this stays free.

- **Always-on data**: Fleet Telemetry (push). Configure once via
  `POST /api/1/vehicles/{vin}/fleet_telemetry_config`, pointed at `freetessie`'s own public
  telemetry receiver (hostname/port/CA) — only possible **after** virtual-key pairing
  (`missing_key` error otherwise). The stream backs `GET /state`'s cached path and the
  `drives`/`charges`/`idles` tables continuously, with no per-call charge beyond the signal
  rate.
- **On-demand live reads**: only for the post-command verification read SPEC.md already
  mandates ("never say done until re-read confirms it"), and only when `realtime:true` is
  passed. Billed per call, but rare — once per user-initiated command, not on a schedule.
- **Wakes**: only when `fleet_status`/the cached online state says the car is asleep and a
  command actually needs it awake — never speculative, since this is the single priciest
  line item.
- **Cost math for Angus's actual pattern** (per-day): ~20 on-demand reads + ~10 commands +
  ~3 wakes ≈ **$3.30/month**, plus Fleet Telemetry streaming at Tesla's own worked example
  (~15 signals/min while driving, $0.00636/hr) for a typical commute pattern — well under
  **$2/month** more. Combined, comfortably under the **$10/month free credit**, net **$0**.
- **The failure mode to design against**: a 60-second `vehicle_data` poll loop for 8 awake
  hours/day costs **~$28.80/month**, overshooting the credit by ~$18-19/month. This isn't
  a tuning knob to get right later — it's an architecture the codebase should make
  structurally impossible (no poller touches `freetessie`'s live-read route; a test should
  assert zero scheduled calls to it, see §5).
- Rate limits (60/min realtime, 30/min commands, 3/min wakes, per device per account) are
  generous for a single-car SMS agent and won't bind in normal use — only relevant as a
  signal that something (a retry storm, a bug) has gone wrong; add exponential backoff and
  a circuit breaker rather than relying on the limit itself as a safety net, since a billed
  failure still costs money even when rate-limited.

### Local API-key design

`freetessie` mints one random 32-byte, base64url bearer token on first boot (or on demand via
`scripts/mint-api-key.ts`), prints the plaintext **once**, and stores only its hash in SQLite
table `api_keys` (id, hash, created_at, label, revoked_at) — the same hash-and-
`timingSafeEqual` idiom `agent.ts` already uses for `USER_PIN`, so the new code matches the
repo's existing security posture rather than inventing a second pattern. Every route checks
`Authorization: Bearer <token>` against the stored hash; a missing or revoked key gets a
plain 401 — this mirrors Tessie's own auth model exactly, which is why `TessieAdapter` needs
no changes at all: it already sends `Authorization: Bearer <token>` to whatever
`TESSIE_BASE_URL` points at.

## 4. Env vars

New, for `freetessie` (on top of this repo's existing `TESSIE_TOKEN`/`TESSIE_VIN`/etc., which
stay as-is on the `backseat-tesla` side — just repointed):

| Var | Purpose |
|---|---|
| `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` | the developer app's own credentials |
| `TESLA_VIN` | the vehicle (same value as `TESSIE_VIN`, just under `freetessie`'s own name) |
| `TESLA_REGION` | `na` \| `eu` \| `cn` — selects `fleet-api.prd.{na,eu,cn}.vn.cloud.tesla.com`; hardcode `na` for Angus's car, don't build region-switching (see §7) |
| `TESLA_PUBLIC_KEY_DOMAIN` | the domain serving the `.well-known` file |
| `TESLA_PRIVATE_KEY_PATH` | local path to the EC private key — never in git |
| `TESLA_OAUTH_REDIRECT_URI` | can differ from the key-hosting domain (Tesla validates these independently) |
| `FREETESSIE_PORT` | default `4000`, loopback-bound; this is the port `TESSIE_BASE_URL` points at |
| `FREETESSIE_DB_PATH` | its own SQLite file, separate process from `backseat-tesla.db` |
| `TELEMETRY_PUBLIC_HOSTNAME`, `TELEMETRY_PORT` | the public FQDN/port the Fleet Telemetry receiver binds — pushed to the vehicle via `fleet_telemetry_config` |
| `TELEMETRY_TLS_CERT_PATH`, `TELEMETRY_TLS_KEY_PATH` | the public-facing cert (Let's Encrypt, or the Cloudflare Tunnel origin cert) |
| `SIGNING_PROXY_PORT` | default `4443`, where the `tesla-http-proxy` sidecar listens on loopback |
| `SIGNING_PROXY_CERT_PATH`, `SIGNING_PROXY_KEY_PATH` | the sidecar's own loopback TLS pair (separate from the Fleet-API-facing "3p" cert) |

On the existing `backseat-tesla` side, the **entire** integration is two env var changes:

| Var | New value |
|---|---|
| `TESSIE_BASE_URL` | `http://127.0.0.1:4000` (or `freetessie`'s public URL, if split across hosts) |
| `TESSIE_TOKEN` | the local key printed by `scripts/mint-api-key.ts` |

## 5. Fake Fleet API server for tests

Keep the existing `test/fakeTessie.ts`/`src/tesla/fakeTessieServer.ts` exactly as-is — nothing
changes there, since `TessieAdapter` is untouched. Add a **new** fake, at the Fleet API layer,
so `freetessie`'s own test suite runs without hitting real Tesla infrastructure. It must emulate:

- `POST /oauth2/v3/token` for both `client_credentials` (partner) and
  `authorization_code`/`refresh_token` (third-party) grants, including the rotating-refresh
  behavior: a 24-hour grace window on the just-superseded token, and an injectable
  `login_required` response to simulate a password-change token kill.
- `POST /api/1/partner_accounts` and `GET /api/1/partner_accounts/public_key?domain=...`
  (the registration round-trip).
- `GET /api/1/vehicles`, `GET /api/1/vehicles/{vin}/vehicle_data` (with a configurable
  "asleep" vs "online" state and latency knob), `GET .../vehicle_data_cached`, and
  `GET .../fleet_status` (key-pairing state, so a `missing_key` rejection path is testable).
- `POST /api/1/vehicles/{vin}/wake_up`, with a simulated 10-60s wake-delay knob.
- The signed-command surface: a fake emulating `tesla-http-proxy`'s own REST shape
  (`POST /api/1/vehicles/{vin}/command/{name}`), with an injectable "virtual key missing"
  rejection and a "this failure is still billable" flag so a test can assert `freetessie`
  doesn't blindly retry a failing signed command. Reserve a real-binary smoke test (actually
  running `tesla-http-proxy` against this fake host) as a separate, manual, non-CI step —
  it needs a real or synthetic vehicle key and isn't worth the CI weight.
- A fake Fleet Telemetry WebSocket endpoint that accepts a connection and lets a test inject
  a scripted signal sequence (JSON is fine for the ingester-logic test; this isn't testing
  the wire protobuf format) — e.g. "feed 3 minutes of `VehicleSpeed>0` then `0`" should
  assert exactly one `drives` row gets created.
- **Call-count tracking per endpoint type**, so a test can assert the no-polling invariant
  directly: e.g. "this whole scenario made exactly 1 wake + 2 commands + 0 live `vehicle_data`
  reads" — turning §3's cost-math promise into something CI actually checks, not just
  something code review has to remember to look for.
- Must **not** emulate or route anything Autopilot/FSD/Summon/drive-shaped. If
  `commandMap.ts`'s translation table is ever asked to map a name outside the ~21 Tessie
  commands `TessieAdapter` already calls, both the fake and the real router should reject it
  (404/400), and a test should assert that rejection explicitly — this keeps the "never add
  one" rule in SPEC.md enforced by a test, not just by comment.

## 6. Risks + gotchas

| # | Risk | Mitigation |
|---|---|---|
| 1 | Virtual-key pairing needs the car online + Tesla app ≥4.27.3 | Onboarding script checks `fleet_status` and tells Angus to wake the car / update the app before sending the pairing link |
| 2 | Changing the Tesla account password kills **every** OAuth token instantly, no workaround (confirmed by Tesla's own maintainers) | Detect `401 login_required` on a refresh attempt, mark the token row dead, push a Telegram alert asking to re-authorize — never retry-loop on this |
| 3 | Refresh tokens are single-use, rotate, and expire after 3 months idle (24h grace on the superseded one) | Persist the new refresh token atomically before using the new access token; never run two processes refreshing concurrently against the same DB row |
| 4 | Only the signed Vehicle Command Protocol works on anything except pre-2021 Model S/X; an unsigned call 403s with a specific documented error body | Route every command through the sidecar, never a raw POST; confirm which Tesla Angus actually has (open question — see RESEARCH.md fleet-commands section) |
| 5 | A signed command **bills even when rejected** because the virtual key silently un-paired | Check `fleet_status`'s key-pairing field before sending a signed command, exactly as Tesla's own best-practices doc recommends; surface "key not paired — re-pair" rather than retrying |
| 6 | NA/EU/China are separate Fleet API hosts, each needing its own `partner_accounts` registration; China needs a wholly separate account | Out of scope — hardcode `TESLA_REGION=na`, document the limitation, don't build region-switching |
| 7 | `vehicle_location` is its own OAuth scope split out from the old blanket data scope — older consents don't include it | Request the full scope set (`openid`, `offline_access`, `vehicle_device_data`, `vehicle_location`, `vehicle_cmds`, `vehicle_charging_cmds`) in the one `/authorize` call during setup |
| 8 | The OAuth token endpoint moved from `auth.tesla.com` to `fleet-auth.prd.vn.cloud.tesla.com` — old tutorials/snippets still point at the dead host and fail with "unexpected issuer" | Hardcode the new host in `fleetAuth.ts` with a comment citing the migration, so nobody "fixes" it back |
| 9 | App registration needs a real HTTPS domain hosting the key file; domain can't contain "Tesla"; Tesla's validator has a documented history of "invalid domain" false rejections traced (unconfirmed root cause) to a lagging CA allowlist | Use a domain whose cert chains through a well-established CA; if rejected with the generic "Domain is invalid" message, try a cert reissue / different CA before assuming the setup itself is broken |
| 10 | Continuous `vehicle_data` polling burns the $10 credit in days, not months (confirmed math: ~$28.80/mo at 60s/8hr) | Architecturally forbidden — no timer touches the live-read route; a test asserts the zero-poll invariant (§5) |
| 11 | GitHub Pages' Jekyll processor (and, per an unconfirmed community report, Cloudflare Pages too) silently drops dot-directories like `.well-known/` unless explicitly un-ignored | Commit `.nojekyll` (GitHub Pages) or the documented Workers-static-assets `.assetsignore`/`!.well-known` workaround for whichever host is actually chosen; verify with a direct `curl` of the live path before registering the partner account |
| 12 | Exceeding the billing limit doesn't just pause API calls — it **permanently drops Fleet Telemetry configs**, not auto-restored | Set a sane billing limit (e.g. $15) once a payment method is on file, so a bug fails loud (a small charge) rather than silently and permanently killing telemetry |
| 13 | `navigation_request` ("share" a destination) is explicitly excluded from the signed protocol in Tesla's own source — routing it through the sidecar like every other command will fail | Special-case it in `commandMap.ts`: call Fleet API directly with the plain OAuth bearer token, not the signing sidecar |
| 14 | The private key must never be committed or hosted — only the public half is served | `.gitignore` it explicitly; reference only by env-var path; never log its contents |
| 15 | Fleet Telemetry requires the receiver to be "exposed to the public internet" with a real cert — a home Mac behind CGNAT can't satisfy this with a bare port-forward | Use a named Cloudflare Tunnel (confirmed working pattern from a real developer's setup) or a cheap VPS/Render instance with a real domain — not a raw port-forward |
| 16 | Unconfirmed whether an individual (non-LLC) applicant is accepted on the app-registration "legal business details" field | Try "individual/personal use" first — community reports suggest it's accepted in practice; flag to Angus as a possible blocker if rejected |

## 7. Out of scope

- Anything Autopilot/FSD/Summon/speed/drive-related, on either API — hard-forbidden,
  identical to this repo's existing `adapter.ts`/SPEC.md rule, carried through to every new
  file's method set and route table without exception.
- Jailbreak/root/firmware work of any kind.
- Any hardware purchase or install (OBD dongle, cellular modem, etc.) — Fleet API and Fleet
  Telemetry are both cloud-only; this stays a no-hardware project.
- Multi-vehicle, multi-owner, or fleet-business features (Tesla-for-Business, Guest Mode,
  driver/role management) — single car, single owner, matching this repo's existing scope.
- China-region support.
- Tessie's value-add features that have no Fleet API equivalent and real build cost of their
  own: battery-health trend charts, rendered "Get Map" images, consumption-since-charge
  modeling, weather, release-notes feed, charging-invoice billing. Could be built later;
  not part of this brief.
- Automations/alerts/geofencing/webhooks as a REST surface — Tessie's own public docs don't
  clearly expose these as API endpoints either (unconfirmed whether they exist at all even
  for Tessie); not attempting to replicate an API whose own existence is unverified.
- Reselling or multi-tenant hosting of `freetessie` for anyone other than Angus's own car.
  Tesla's Fleet API terms likely restrict sublicensing/reselling (exact clause unconfirmed —
  tesla.com's legal pages blocked automated fetch); this brief stays scoped to exactly the
  single-owner, personal-use pattern Tessie/Teslemetry/TeslaMate themselves already run on.
- The in-car browser / "/screen" dashboard idea. Separate, much smaller feature, not part of
  this brief — there's no JS bridge on the car's own screen to anything vehicle-related; a
  page there would just be a normal webpage hitting this same backend from outside the car.
- A literal Model Context Protocol (MCP) server mirroring Tessie's own — not requested, not
  needed for a Telegram/SMS agent.

## 8. Sources

Tesla official docs:
- https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api
- https://developer.tesla.com/docs/fleet-api/billing-and-limits
- https://developer.tesla.com/docs/fleet-api/getting-started/best-practices
- https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints
- https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints
- https://developer.tesla.com/docs/fleet-api/authentication/overview
- https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens
- https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens
- https://developer.tesla.com/docs/fleet-api/fleet-telemetry
- https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide
- https://developer.tesla.com/docs/fleet-api/announcements
- https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries

Tesla's own open-source signing stack:
- https://github.com/teslamotors/vehicle-command (README + `pkg/proxy/command.go` + `cmd/tesla-http-proxy/main.go`)
- https://github.com/teslamotors/fleet-telemetry
- https://github.com/teslamotors/vehicle-command/issues/132 (password change kills tokens)
- https://github.com/teslamotors/vehicle-command/issues/477 (domain-validator rejections)
- https://github.com/jankeesvw/omarchy-tesla/issues/8 (unsigned-command 403 body)

Key hosting, real working examples:
- https://github.com/sagarpatel510/sagarpatel510.github.io/pull/1
- https://github.com/Head2Wind/tesla-fleet-key
- https://github.com/home-assistant/core/issues/184213 (Cloudflare Tunnel setup, validated)

Tessie (the thing being replaced):
- https://developer.tessie.com/reference
- https://developer.tessie.com/openapi.yaml
- https://developer.tessie.com/llms.txt
- https://developer.tessie.com/reference/authentication
- https://developer.tessie.com/reference/get-telemetry-config
- https://tessie.com/pricing
- https://www.tessie.com/developers
- https://haveyoumetvolt.com/blog/tesla-app-comparison-2026

Ecosystem / prior art:
- https://github.com/teslamate-org/teslamate
- https://docs.teslamate.org/docs/configuration/api/
- https://github.com/Teslemetry/python-tesla-fleet-api
- https://github.com/functionpointer/tesla-http-proxy-standalone
- https://github.com/BankkRoll/tesdk
- https://github.com/tdorssers/TeslaPy
- https://www.myteslamate.com/api/
- https://www.myteslamate.com/blog/teslamate-vs-teslemetry/

Pricing (treat the exact per-signal figure as disputed — see RESEARCH.md fleet-billing):
- https://teslemetry.com/blog/tesla-fleet-api-pay-per-use
- https://www.notateslaapp.com/news/2415/tesla-announces-api-pricing-third-party-service-costs-expected-to-rise
- https://desertlakes.io/tesla-fleet-api-pricing-streaming-vs-polling/

Repo (read-only, for the existing interface this brief builds against):
- `src/tesla/adapter.ts`, `src/tesla/tessieAdapter.ts`, `SPEC.md`, `ARCHITECTURE.md` in
  `backseat-tesla-ro`.
