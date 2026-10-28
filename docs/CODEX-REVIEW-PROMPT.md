You are reviewing `roadster-api`, a TypeScript/Node 26 repo in the current directory: a self-hosted
"text your Tesla" agent (Telegram / Twilio SMS → Claude tool-use loop → vehicle adapter) with
`freetessie`, a Tessie-compatible REST server that talks to Tesla's official Fleet API using the
owner's own developer app. It was derived from `backseat-tesla` and adds a Roadster command
manifest, a `roadster_flight` tool, and "Airtime" (hours saved over traffic, computed from drive
history). Read `README.md`, `ARCHITECTURE.md`, `SPEC.md`, `docs/FREETESSIE-BRIEF.md` and
`docs/FREETESSIE_SETUP.md` first.

Run `npm test`, `npx tsc --noEmit`, `npm run e2e` and `npm run airtime -- --demo` and report the
real numbers. You may read everything and run tests; do not edit files. Use synthetic credentials
only; never attempt a real Tesla, Twilio, Telegram or Anthropic call.

Review these five things, in order, and for each give: verdict (pass / fix / block), the exact
file:line, a concrete failure scenario, and the smallest fix.

1. **API-key and pairing security (freetessie).** `src/freetessie/apiKeys.ts`, `loginTokens.ts`,
   `fleetAuth.ts`, `tokenStore.ts`, `server.ts`. Can anyone without the local bearer key reach a
   vehicle command? Is the one-time login token single-use and expiring? Are Tesla refresh tokens
   ever logged, returned by a route, or written anywhere but the token store? Is the public-key
   route the only unauthenticated route? Is there any path that forwards an unrecognised command
   name to Tesla?

2. **The flight-command boundary.** `src/roadster/manifest.ts`, the `roadster_flight` tool in
   `src/agent/tools.ts`, the system prompt and `DRIVING_KEYWORDS` in `src/agent/agent.ts`,
   `test/agent/roadster.test.ts`. The rule: a request to fly/hover/land/jump must never reach any
   vehicle function, and nothing in the repo may drive, steer, summon or touch Autopilot/FSD.
   Try to break it: phrasings that dodge the keyword gate, a `schedule_action` wrapping a flight,
   a flight request that the model might map onto `nav_send_destination`. Say whether the
   defence is in code or only in prompt text, and what would make it code.

3. **Airtime math.** `src/roadster/airtime.ts`, `airtimeHistory.ts`, `scripts/airtime.ts`,
   `test/roadster/airtime.test.ts`. Check the haversine, the ISO-week bucketing across New Year,
   the clamp at zero, the route-key collapsing, and that the two constants (160 km/h cruise,
   120 s overhead) are labelled hypothetical everywhere they surface, including `web/airtime.html`.
   Does `airtimeHistory.ts` read the history store's drive rows correctly (null handling, open
   rows, ms vs s)?

4. **README claims vs code.** Every sentence in `README.md` that states a capability, a number, a
   price, or a Tesla fact: is it true of this code and of Tesla's published Fleet API docs as you
   know them? Flag anything that overstates what runs today versus what awaits Tesla.

5. **Anything else that would embarrass a public repo**: secrets, PII, leftover backseat naming,
   dead code, a dependency that is not justified in `x-deps-why`, a test that cannot fail.

Finish with a one-paragraph verdict: ship / ship-with-fixes / do-not-ship, and the ordered fix list.
Be specific and short. No praise.
