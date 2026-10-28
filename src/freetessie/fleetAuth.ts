// FleetAuth: Tesla Fleet API OAuth — owner authorization-code flow (consent, exchange,
// refresh-with-rotation) plus the partner client_credentials token used only for
// POST /api/1/partner_accounts.
//
// Request shapes verified against Tesla's own docs (2026-10-27):
//   https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens
//   https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens
// The token endpoint lives on fleet-auth.prd.vn.cloud.tesla.com, not auth.tesla.com —
// the /authorize page is the one piece still on the old host. Docs confirm the
// refresh_token grant omits client_secret (unlike authorization_code), so don't "fix"
// that back in — see docs/FREETESSIE-BRIEF.md risk #8.

import {
  DeadTokenError,
  FLEET_AUTH_HOST,
  FLEET_HOSTS,
  OWNER_SCOPES,
  TESLA_AUTHORIZE_URL,
  TOKEN_PATH,
  type FleetAuth,
  type FreeTessieConfig,
  type OwnerTokens,
  type TokenStore,
} from "./contracts.ts";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Partner tokens (client_credentials) are only ever used for POST /api/1/partner_accounts
// and fleet_status — they can't carry user-consent scopes. offline_access controls refresh-
// token issuance, which this grant never returns, and vehicle_location is per-vehicle-consent
// with no partner-level meaning; Tesla's partner-tokens doc and every public example omit both.
// Reusing OWNER_SCOPES here risks invalid_scope and would brick registerPartner() at setup.
const PARTNER_SCOPES = ["openid", "vehicle_device_data", "vehicle_cmds", "vehicle_charging_cmds"];

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export function createFleetAuth(opts: {
  config: FreeTessieConfig;
  store: TokenStore;
  fetchImpl?: typeof fetch;
}): FleetAuth {
  const { config, store } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  const tokenUrl = `${config.authBaseUrl ?? FLEET_AUTH_HOST}${TOKEN_PATH}`;
  // The real Tesla audience is always one of FLEET_HOSTS — it names the resource
  // server a token is scoped to, which is independent of fleetBaseUrl's role as a
  // test override for where Fleet API *requests* go.
  const audience = FLEET_HOSTS[config.region];

  async function postToken(body: URLSearchParams): Promise<{ status: number; text: string }> {
    const res = await doFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  // requestedScope/fallbackRefreshToken cover response bodies that omit a field —
  // the refresh grant always rotates in practice, but don't crash if a fixture doesn't.
  function parseTokens(
    text: string,
    requestedScope: string,
    fallbackRefreshToken: string | undefined,
  ): OwnerTokens {
    const raw = JSON.parse(text) as RawTokenResponse;
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token ?? fallbackRefreshToken ?? "",
      expiresAt: Date.now() + raw.expires_in * 1000,
      scope: raw.scope ?? requestedScope,
      dead: false,
    };
  }

  async function doRefresh(current: OwnerTokens): Promise<OwnerTokens> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: current.refreshToken,
    });
    const { status, text } = await postToken(body);
    // login_required means the owner's Tesla password changed — every token is dead,
    // no retry can recover it. Checked on status OR body text since Tesla's error
    // shape for this case isn't nailed down to one exact field in the public docs.
    if (status === 401 || text.includes("login_required")) {
      store.markDead();
      throw new DeadTokenError();
    }
    if (status < 200 || status >= 300) {
      throw new Error(`Tesla token refresh failed: HTTP ${status}`);
    }
    const tokens = parseTokens(text, current.scope, current.refreshToken);
    // Persist the new (rotated) refresh token BEFORE returning — losing this write
    // after the fact means the caller walks away with an access token this store
    // can never refresh again.
    store.save(tokens);
    return tokens;
  }

  // Two concurrent validAccessToken() callers near expiry must not both hit Tesla's
  // token endpoint (and must not both try to rotate the same refresh token, which
  // would make the loser's rotation invalid) — so every refresh() call joins one
  // in-flight request if there is one.
  let inflightRefresh: Promise<OwnerTokens> | null = null;

  function refresh(current: OwnerTokens): Promise<OwnerTokens> {
    if (!inflightRefresh) {
      inflightRefresh = doRefresh(current).finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  }

  return {
    authorizeUrl(state: string): string {
      const url = new URL(TESLA_AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", OWNER_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code: string): Promise<OwnerTokens> {
      const requestedScope = OWNER_SCOPES.join(" ");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        audience,
        redirect_uri: config.redirectUri,
        scope: requestedScope,
      });
      const { status, text } = await postToken(body);
      if (status < 200 || status >= 300) {
        throw new Error(`Tesla code exchange failed: HTTP ${status}`);
      }
      const tokens = parseTokens(text, requestedScope, undefined);
      store.save(tokens);
      return tokens;
    },

    refresh,

    async partnerToken(): Promise<string> {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience,
        scope: PARTNER_SCOPES.join(" "),
      });
      const { status, text } = await postToken(body);
      if (status < 200 || status >= 300) {
        throw new Error(`Tesla partner token request failed: HTTP ${status}`);
      }
      const raw = JSON.parse(text) as { access_token: string };
      return raw.access_token; // deliberately never passed to store.save()
    },

    async validAccessToken(): Promise<string> {
      const current = store.load();
      if (!current || current.dead) {
        throw new DeadTokenError();
      }
      const msUntilExpiry = current.expiresAt - Date.now();
      if (msUntilExpiry >= REFRESH_MARGIN_MS) {
        return current.accessToken;
      }
      const refreshed = await refresh(current);
      return refreshed.accessToken;
    },
  };
}
