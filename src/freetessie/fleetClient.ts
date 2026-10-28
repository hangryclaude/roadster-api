// fleetClient: the one place that actually talks to Tesla's Fleet API wire protocol.
// Paths/bodies verified against developer.tesla.com/docs/fleet-api/endpoints/{vehicle-endpoints,
// vehicle-commands} and the real teslamotors/vehicle-command source (pkg/proxy/command.go,
// pkg/proxy/proxy.go) plus Teslemetry/python-tesla-fleet-api (a maintained production client) —
// not guessed. See the per-method comments for what each fact traces back to.
//
// Same hard rule as adapter.ts/tessieAdapter.ts: nothing here calls, or could be asked to call,
// anything Autopilot/FSD/Summon/speed/drive-shaped. The only command surface this module exposes
// is FleetCommandName (contracts.ts's closed list) plus the two carve-outs (wake, navigation)
// that Tesla's own docs document as not going through the signed-command path.

import {
  FLEET_HOSTS,
  VEHICLE_DATA_ENDPOINTS,
  CommandError,
  type FreeTessieConfig,
  type FleetClient,
  type FleetCallCounts,
  type FleetVehicleData,
  type FleetCommandName,
} from "./contracts.ts";

const DEFAULT_WAKE_TIMEOUT_MS = 60_000;
// Matches python-tesla-fleet-api's own wake-poll cadence (it polls the vehicle() endpoint,
// not wake_up itself, "which is rate limited" — its comment, confirmed in its source).
const WAKE_POLL_INTERVAL_MS = 3_000;
// "At most 2 retries" per the brief — 3 total attempts for a retryable read.
const MAX_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;

// The exact 403 body Fleet API returns for a vehicle that needs the signed Vehicle Command
// Protocol and didn't get it (confirmed via the jankeesvw/omarchy-tesla issue the brief cites):
//   {"error":"Tesla Vehicle Command Protocol required, please refer to the documentation
//    here: https://developer.tesla.com/docs/fleet-api/announcements#2023-10-09-...", ...}
const PROTOCOL_REQUIRED_MARKER = "Tesla Vehicle Command Protocol required";

interface CreateFleetClientOpts {
  config: FreeTessieConfig;
  getAccessToken: () => Promise<string>;
  getPartnerToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body (e.g. an HTML error page from an intermediary) is still a
    // failure the caller needs to see, just not as structured data.
    return { raw: text };
  }
}

// Every real Fleet API response wraps its payload in {"response": ...} — confirmed by
// pkg/proxy/proxy.go's `Response` struct (`Response interface{} \`json:"response"\`) and
// mirrored by every route the fake server implements.
function unwrapResponse(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "response" in body) {
    return (body as { response: unknown }).response;
  }
  return body;
}

export function createFleetClient(opts: CreateFleetClientOpts): FleetClient {
  const { config, getAccessToken, getPartnerToken, fetchImpl = fetch } = opts;
  const fleetBase = config.fleetBaseUrl ?? FLEET_HOSTS[config.region];

  const counts: FleetCallCounts = {
    vehicleData: 0,
    wake: 0,
    command: 0,
    navigation: 0,
    fleetStatus: 0,
  };

  // Real tesla-http-proxy TLS: Node's global fetch has no per-request custom-CA option,
  // so against the actual sidecar (self-signed "snakeoil" loopback cert, per the brief)
  // the operator must set NODE_EXTRA_CA_CERTS to the proxy's cert file before this process
  // starts — there is no code-level workaround. Tests point signingProxyUrl at the fake
  // server over plain http, so this never bites in CI.

  // Reads only: at most 2 retries, backoff only on 429/5xx/network errors. Never used for
  // wake_up or a signed command — both are billable even on failure, so a retry would double
  // the bill for nothing.
  async function fetchReadWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      try {
        const res = await fetchImpl(url, init);
        const retryableStatus = res.status === 429 || res.status >= 500;
        if (retryableStatus && attempt < MAX_READ_ATTEMPTS - 1) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastNetworkError = err;
        if (attempt < MAX_READ_ATTEMPTS - 1) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
      }
    }
    throw lastNetworkError;
  }

  async function authedGet(path: string): Promise<unknown> {
    const token = await getAccessToken();
    const res = await fetchReadWithRetry(`${fleetBase}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await parseJsonBody(res);
    if (!res.ok) {
      throw new Error(`Fleet API GET ${path} failed: HTTP ${res.status}`);
    }
    return unwrapResponse(body);
  }

  return {
    counts,

    async vehicles(): Promise<unknown> {
      // GET /api/1/vehicles — paginated list, 100/page by default per the docs; freetessie
      // only ever has one car, so pagination is intentionally not implemented here.
      return authedGet("/api/1/vehicles");
    },

    async vehicleData(): Promise<FleetVehicleData> {
      counts.vehicleData++;
      // The real Fleet API joins endpoint names with ";" — confirmed in
      // python-tesla-fleet-api's vehicle_data(): `";".join(endpoints)`.
      const qs = `endpoints=${VEHICLE_DATA_ENDPOINTS.join(";")}`;
      const raw = await authedGet(
        `/api/1/vehicles/${config.vin}/vehicle_data?${qs}`,
      );
      return raw as FleetVehicleData;
    },

    async wake(timeoutMs = DEFAULT_WAKE_TIMEOUT_MS): Promise<void> {
      counts.wake++;
      const token = await getAccessToken();
      // Billable and never retried — a dropped response here must not turn into two wakes.
      const res = await fetchImpl(`${fleetBase}/api/1/vehicles/${config.vin}/wake_up`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        await parseJsonBody(res).catch(() => undefined);
        throw new Error(`Fleet API wake_up failed: HTTP ${res.status}`);
      }
      await parseJsonBody(res);

      // Poll GET /api/1/vehicles/{vin} ("vehicle()" in python-tesla-fleet-api), not
      // vehicle_data — its own comment confirms this is "not rate limited" the way
      // wake_up is, and it isn't a billable vehicle_data read either.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const info = (await authedGet(`/api/1/vehicles/${config.vin}`)) as {
          state?: string;
        };
        if (info?.state === "online") return;
        // Never sleep past the deadline just to poll again — a short timeoutMs (tests,
        // or a caller that wants to fail fast) shouldn't have to wait out a full interval.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(WAKE_POLL_INTERVAL_MS, remaining));
      }
      throw new Error(
        `vehicle did not reach "online" within ${timeoutMs}ms of waking`,
      );
    },

    async fleetStatus(): Promise<{
      online: boolean;
      keyPaired: boolean | null;
      raw: unknown;
    }> {
      counts.fleetStatus++;
      // This is a batch endpoint, not a per-VIN path — confirmed against the real docs
      // and python-tesla-fleet-api's fleet_status(vins): POST /api/1/vehicles/fleet_status
      // with {"vins": [...]}, not GET .../vehicles/{vin}/fleet_status.
      const token = await getAccessToken();
      const res = await fetchReadWithRetry(
        `${fleetBase}/api/1/vehicles/fleet_status`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ vins: [config.vin] }),
        },
      );
      const body = await parseJsonBody(res);
      if (!res.ok) {
        throw new Error(`Fleet API fleet_status failed: HTTP ${res.status}`);
      }
      const raw = unwrapResponse(body);
      const obj = (raw ?? {}) as Record<string, unknown>;
      // Tesla's docs confirm vehicle_command_protocol_required/firmware_version/etc are
      // present on this endpoint but do not publish the exact key-pairing field name in
      // any primary source we could reach — key_paired_vins is this repo's best-informed
      // read (consistent with the docs' "fewer than 20 paired keys" framing and the
      // unpaired_vins/vehicle_info shape the fake server mirrors). Flagged as unconfirmed;
      // see the build report's open_questions.
      const pairedVins = Array.isArray(obj.key_paired_vins)
        ? (obj.key_paired_vins as unknown[]).filter((v) => typeof v === "string")
        : null;
      const keyPaired = pairedVins ? pairedVins.includes(config.vin) : null;
      // fleet_status has no documented awake/asleep field (that lives on vehicle_data /
      // the vehicle() endpoint) — never guess a state we didn't actually read.
      return { online: false, keyPaired, raw };
    },

    async signedCommand(
      name: FleetCommandName,
      body?: Record<string, unknown>,
    ): Promise<void> {
      counts.command++;
      const token = await getAccessToken();
      const url = `${config.signingProxyUrl}/api/1/vehicles/${config.vin}/command/${name}`;
      let res: Response;
      try {
        // Billable even on failure — never retried, same as wake.
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
        });
      } catch (err) {
        throw new CommandError(
          name,
          `request to signing proxy failed: ${(err as Error).message}`,
        );
      }
      const parsed = await parseJsonBody(res);

      if (res.status === 403) {
        const errText =
          typeof (parsed as { error?: unknown })?.error === "string"
            ? (parsed as { error: string }).error
            : "";
        if (errText.includes(PROTOCOL_REQUIRED_MARKER)) {
          throw new CommandError(
            name,
            "this car requires the Tesla Vehicle Command Protocol — pair the virtual key " +
              "(tesla.com/_ak/<domain>) and route this command through the signing proxy",
          );
        }
        throw new CommandError(name, `HTTP 403${errText ? `: ${errText}` : ""}`);
      }
      if (!res.ok) {
        throw new CommandError(name, `HTTP ${res.status}`);
      }

      // carResponse shape per pkg/proxy/proxy.go: {"response":{"result":bool,"reason":string}}.
      const envelope = unwrapResponse(parsed) as
        | { result?: boolean; reason?: string }
        | undefined;
      if (envelope && envelope.result === false) {
        throw new CommandError(name, envelope.reason ?? "unknown reason");
      }
    },

    async navigationRequest(address: string): Promise<void> {
      counts.navigation++;
      // navigation_request is explicitly carved out of the signed protocol — Tesla's own
      // source returns ErrCommandUseRESTAPI ("command requires using the REST API") for it
      // in pkg/proxy/command.go, so this goes straight to the Fleet host with the plain
      // owner bearer token, never through the signing proxy.
      const token = await getAccessToken();
      // Body shape confirmed in python-tesla-fleet-api's navigation_request(): a flat
      // "android.intent.extra.TEXT" key under value, not a nested android/intent/extra tree.
      let res: Response;
      try {
        res = await fetchImpl(
          `${fleetBase}/api/1/vehicles/${config.vin}/command/navigation_request`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "share_ext_content_raw",
              value: { "android.intent.extra.TEXT": address },
              locale: "en-US",
              timestamp_ms: Date.now(),
            }),
          },
        );
      } catch (err) {
        throw new CommandError(
          "navigation_request",
          `request failed: ${(err as Error).message}`,
        );
      }
      const parsed = await parseJsonBody(res);
      if (!res.ok) {
        throw new CommandError("navigation_request", `HTTP ${res.status}`);
      }
      const envelope = unwrapResponse(parsed) as
        | { result?: boolean; reason?: string }
        | undefined;
      if (envelope && envelope.result === false) {
        throw new CommandError("navigation_request", envelope.reason ?? "unknown reason");
      }
    },

    async registerPartner(domain: string): Promise<unknown> {
      if (!getPartnerToken) {
        throw new Error("registerPartner requires opts.getPartnerToken");
      }
      const token = await getPartnerToken();
      const res = await fetchImpl(`${fleetBase}/api/1/partner_accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain }),
      });
      const body = await parseJsonBody(res);
      if (!res.ok) {
        throw new Error(`Fleet API partner_accounts failed: HTTP ${res.status}`);
      }
      return unwrapResponse(body);
    },
  };
}
