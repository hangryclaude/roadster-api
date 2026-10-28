# Free Tessie setup

The owner's path through standing up `freetessie` — a self-hosted Tessie replacement on
Tesla's official Fleet API, using your own Tesla developer app instead of a Tessie
subscription. Steps are numbered in the order they actually need to happen, mirroring
`docs/FREETESSIE-BRIEF.md` §2. **[YOU]** marks a step nobody and nothing else can do for
you — not Claude, not a script, not this codebase. Everything else is one command.

Design details and the full fact list with sources live in `docs/FREETESSIE-BRIEF.md`;
this doc is just the runbook.

## 1. [YOU] Confirm your Tesla Account is ready

Verified email and MFA enabled. Most accounts already have both — check at
[tesla.com/teslaaccount](https://www.tesla.com/teslaaccount) if unsure.

## 2. [YOU] Register a developer app

Go to [developer.tesla.com/request](https://developer.tesla.com/request) and fill in:

- **App name** / **description** — anything descriptive; this is private to your account.
- **Purpose of use** — describe it as personal-use vehicle control for your own car.
- **Legal business details** — enter yourself as an individual. (Community reports say
  this is accepted in practice for personal use; Tesla's docs don't confirm it outright —
  if this field rejects "individual," that's the one real snag to flag back.)

No credit card is needed at this step. Note the **Client ID** and **Client Secret** it
gives you — these become `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET` in `.env`.

## 3. Generate the signing keypair

```
npm run freetessie:setup -- keygen
```

Writes `keys/private-key.pem` (mode 600, never committed — `.gitignore` already excludes
`keys/`) and `keys/public-key.pem`. Prints the exact URL the public key must be reachable
at once `TESLA_PUBLIC_KEY_DOMAIN` is set in `.env`. Safe to re-run — it refuses to
overwrite an existing keypair.

## 4. Host the public key

The printed URL (`https://<TESLA_PUBLIC_KEY_DOMAIN>/.well-known/appspecific/com.tesla.3p.public-key.pem`)
must serve `keys/public-key.pem`'s exact contents, no redirect. Two ways to satisfy this:

- **GitHub Pages** — commit `keys/public-key.pem` to a `*.github.io` repo at that exact
  path, plus a `.nojekyll` file (GitHub Pages' Jekyll processor silently drops
  dot-directories like `.well-known/` otherwise).
- **This process itself** — set `TESLA_PUBLIC_KEY_PATH=keys/public-key.pem` in `.env`;
  `freetessie` serves it directly at that path once it's running (step 12). Only works if
  `TESLA_PUBLIC_KEY_DOMAIN` is a domain actually routed to this machine (see step 9).

Either way, `curl` the live URL before step 6 — Tesla's domain validator has a documented
history of false "invalid domain" rejections, and a live check here rules out "the file
isn't actually there" before blaming that.

## 5. [YOU] Decide and register the domain

Pick GitHub Pages (free) or buy a cheap domain for the tunnel route (~$10/yr), then paste
that domain into the developer app's **Allowed Origin** field and `TESLA_OAUTH_REDIRECT_URI`
(e.g. `https://<domain>/auth/tesla/callback`) into its **Allowed Redirect URI** field, on
`developer.tesla.com`'s dashboard. This is a web-UI form — there's no API for it.

## 6. Register the partner account

```
npm run freetessie:setup -- register
```

One-time `POST /api/1/partner_accounts`, using a `client_credentials` partner token.
Requires `TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`/`TESLA_PUBLIC_KEY_DOMAIN` already in
`.env`, and step 4's public key already live at its URL — Tesla checks that URL as part
of this call.

## 7. [YOU] Complete the OAuth consent

```
npm run freetessie:setup -- login-url
```

Prints a **one-time login link** (valid 15 minutes) into your running `freetessie`. Open
it, it forwards you to Tesla; log into **your own** Tesla account and approve the
requested scopes. Only the vehicle's owner can grant this — nobody can click "approve" on
your behalf. The link carries a single-use token so a stranger who finds your public
domain cannot connect *their* Tesla to your server first; without it the route answers
403, and once you are connected it answers 409.

If you're on the tunnel route from step 5, Tesla redirects the browser back to your own
`freetessie` process at `/auth/tesla/callback`, which completes the exchange itself and
shows "Tesla connected." Nothing further to do here — skip straight to step 8.

## 7b. [YOU, if you went GitHub Pages in step 5] Finish the exchange by hand

GitHub Pages has no server behind it, so Tesla's redirect to
`https://<user>.github.io/auth/tesla/callback?code=...&state=...` lands on a static 404.
That's expected — the `code` you need is still sitting right there in the browser's
address bar. Copy it (everything after `code=` and before `&state=`), then hand it to
your locally-running `freetessie` process directly:

```
curl -X POST http://127.0.0.1:4000/auth/tesla/code \
  -H "Authorization: Bearer <your FREETESSIE_LOCAL_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"code":"<paste the code here>"}'
```

This route needs your local API key (step 11, `mint-key`) — mint it first if you have
not; the key is what proves the paste came from you and not from someone else's browser.

(Use whatever port `freetessie` actually booted on — `FREETESSIE_PORT` in `.env`, default
`4000`, as printed when `npm run dev` started.) A "Tesla connected" response means the
exchange worked; proceed to step 8. This is `/auth/tesla/code`, the paste-the-code
fallback `server.ts` built for exactly this situation — the GitHub Pages path never gets
a working callback redirect, so this step is not optional on that path.

## 8. [YOU, physical] Pair the virtual key

```
npm run freetessie:setup -- pair
```

Prints `https://tesla.com/_ak/<domain>`. Open that link **from the Tesla app on your
phone**, with the car **online** and the app at version ≥4.27.3, then tap Approve. Tesla's
own docs are explicit that this cannot be done remotely — a person with the app and
vehicle access must physically tap it. This is the one step in the whole setup with no
scripted alternative, full stop.

## 9. [YOU, if using the tunnel route] Set up the public tunnel

If you went with a tunnelled domain instead of GitHub Pages in step 5: run
`cloudflared tunnel login` once (needs your own Cloudflare account) and create the named
tunnel pointed at this machine. GitHub Pages users skip this step entirely.

## 10. Build and run the signing proxy

```
npm run freetessie:proxy
```

Builds Tesla's own open-source `tesla-http-proxy` (from `teslamotors/vehicle-command`,
cloned into `.freetessie-proxy-src/` and built with `go build` — plain `go install
...@latest` doesn't work against this repo, since its `go.mod` carries a `replace`
directive that Go's module installer categorically refuses), generates a self-signed
loopback TLS cert if missing, and runs it bound to `127.0.0.1:4443`. Leave it running in
its own terminal/process — `freetessie` is its only caller. The script prints the
`NODE_EXTRA_CA_CERTS` line the `freetessie` process itself needs so Node's `fetch` trusts
that self-signed cert.

## 11. Mint (or let it auto-mint) a local API key

Optional — `npm run dev` with `FLEET_MODE=1` mints one automatically at boot and prints
it once to stderr if `FREETESSIE_LOCAL_KEY` isn't already set. To mint one ahead of time
instead (so it survives across restarts without a fresh mint each time):

```
npm run freetessie:setup -- mint-key
```

Copy the printed token into `.env` as `FREETESSIE_LOCAL_KEY`.

## 12. Boot

In `.env`, set `FLEET_MODE=1` plus everything steps 2-11 produced
(`TESLA_CLIENT_ID`/`TESLA_CLIENT_SECRET`/`TESLA_VIN`/`TESLA_PUBLIC_KEY_DOMAIN`/etc — see
`.env.example`'s Free Tessie block), then:

```
npm run dev
```

`freetessie` boots in-process on its own loopback port and `TessieAdapter` points at it
automatically — no further code or config beyond `.env`.

## 13. Check it

```
npm run freetessie:setup -- status
```

Reports whether Tesla tokens are alive, whether the virtual key shows as paired, and how
stale the cached vehicle state is.

## Everything else

SQLite schema/migrations, local API-key minting, and the test suite are all scriptable
with no further human action — `npm run build && npm test && npm run e2e` exercises the
whole stack (real modules, two fake Fleet/Tessie backends) without touching a real car or
costing a real Tesla API call.

## What this costs

Tesla's Fleet API bills per call, with a **$10/month free credit per developer account**.
Numbers below are computed from Tesla's own published 2026 rates — Tesla has already
raised Fleet API pricing at least once since launch, so treat **~40% above these numbers**
as the realistic worst case before assuming something is misconfigured, not a fixed quote.

| Pattern | Est. monthly cost | Why |
|---|---|---|
| Typical use (~20 on-demand reads + ~10 commands + ~3 wakes/day) | **~$3.30, net $0** | one-off, user-triggered calls only, comfortably inside the $10/mo credit |
| The one design mistake that blows the budget: a 60-second `vehicle_data` poll loop, 8 awake hrs/day | ~$28.80 | **architecturally forbidden in this codebase** — nothing here runs on a timer, by design, not by convention |

Fleet Telemetry (Tesla's push-streaming surface for drives/charges in progress) is **out
of scope for this build**. There's no ingester, no `fleet_telemetry_config` call, and no
`TELEMETRY_*` env var anywhere in `freetessie` — drive/charge/idle history in
`src/freetessie/history.ts` only ever gets a row when something else (an on-demand
command or state check) triggers a live `vehicle_data` read, so it'll be sparse and
gap-prone relative to a real continuous trace, not a push stream running in the
background. If that's wanted later, it's a separate build on top of this one.

## What this will never do

Exactly the same hard line as the rest of this repo (`SPEC.md`, `src/tesla/adapter.ts`):
nothing here is, or routes to, Autopilot, Full Self-Driving, Summon, steering, speed
control, or anything else that drives the car — on Tesla's Fleet API or any other surface.
No jailbreak, root, or firmware access exists or will ever be added. No hardware is
purchased or installed; this stays cloud-only. This is one owner, one car — not a
multi-tenant service, and not resold or hosted for anyone else's Tesla account.
