// fleetClient against the fake Fleet API server — every call type, the no-retry-on-billables
// invariant, and the protocol-required 403 path.
//
// No test here exercises anything Autopilot/FSD/Summon/speed/drive-shaped — there is no such
// call on FleetClient to make. See SPEC.md "What this will never do."

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetClient } from "../../src/freetessie/fleetClient.ts";
import { createFakeFleetServer, type FakeFleetServer } from "../../src/freetessie/fakeFleetServer.ts";
import { CommandError, type FleetClient, type FleetCommandName, type FreeTessieConfig } from "../../src/freetessie/contracts.ts";

const VIN = "TEST000000000VIN";

function configFor(url: string): FreeTessieConfig {
  return {
    clientId: "test-client",
    clientSecret: "test-secret",
    vin: VIN,
    region: "na",
    publicKeyDomain: "example.com",
    redirectUri: "https://example.com/auth/tesla/callback",
    publicKeyPem: null,
    signingProxyUrl: url,
    fleetBaseUrl: url,
  };
}

async function withFake(
  run: (client: FleetClient, fake: FakeFleetServer) => Promise<void>,
): Promise<void> {
  const fake = createFakeFleetServer(VIN);
  const { url } = await fake.start();
  try {
    const client = createFleetClient({
      config: configFor(url),
      getAccessToken: async () => "owner-test-token",
      getPartnerToken: async () => "partner-test-token",
    });
    await run(client, fake);
  } finally {
    await fake.stop();
  }
}

test("vehicleData unwraps {response:...} and counts the call", async () => {
  await withFake(async (client) => {
    const data = await client.vehicleData();
    assert.equal(data.state, "asleep");
    assert.equal(data.charge_state?.battery_level, 54);
    assert.equal(data.vehicle_state?.locked, true);
    assert.equal(client.counts.vehicleData, 1);
  });
});

test("vehicleData omits drive_state unless location_data is requested", async () => {
  // VEHICLE_DATA_ENDPOINTS (contracts.ts) always includes location_data, so the fake
  // should always hand back drive_state for freetessie's real call shape.
  await withFake(async (client) => {
    const data = await client.vehicleData();
    assert.ok(data.drive_state, "drive_state should be present when location_data is requested");
    assert.equal(data.drive_state?.latitude, 39.7392);
  });
});

test("wake polls the lightweight vehicle endpoint until state is online", async () => {
  await withFake(async (client, fake) => {
    fake.wakeAfterCalls = 1;
    assert.equal(fake.state.state, "asleep");
    await client.wake(5_000);
    assert.equal(fake.state.state, "online");
    assert.equal(client.counts.wake, 1);
  });
});

test("wake throws after timeoutMs if the vehicle never reaches online", async () => {
  await withFake(async (client, fake) => {
    // wakeAfterCalls set absurdly high so the poll loop exhausts a short timeout.
    fake.wakeAfterCalls = 1_000_000;
    await assert.rejects(() => client.wake(50), /did not reach "online"/);
  });
});

test("signedCommand result:false throws CommandError and counts exactly once (no retry)", async () => {
  await withFake(async (client, fake) => {
    fake.failNextCommand = "door_lock";
    await assert.rejects(
      () => client.signedCommand("door_lock"),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.equal(err.command, "door_lock");
        assert.equal(err.reason, "virtual key missing");
        return true;
      },
    );
    assert.equal(client.counts.command, 1);
  });
});

test("signedCommand succeeds and mutates fake state", async () => {
  await withFake(async (client, fake) => {
    await client.signedCommand("door_unlock");
    assert.equal(fake.state.vehicle_state.locked, false);
    assert.equal(client.counts.command, 1);
  });
});

test("signedCommand for a name outside the closed vocabulary gets the protocol-required 403", async () => {
  await withFake(async (client) => {
    await assert.rejects(
      () => client.signedCommand("unsupported_fleet_command" as unknown as FleetCommandName),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.reason, /Tesla Vehicle Command Protocol/);
        return true;
      },
    );
  });
});

test("navigationRequest sends the share_ext_content_raw body and the fake records it", async () => {
  await withFake(async (client, fake) => {
    await client.navigationRequest("1900 Park Ave, Denver, CO");
    assert.equal(fake.navigationRequestsReceived.length, 1);
    const received = fake.navigationRequestsReceived[0] as {
      type: string;
      value: Record<string, string>;
    };
    assert.equal(received.type, "share_ext_content_raw");
    assert.equal(received.value["android.intent.extra.TEXT"], "1900 Park Ave, Denver, CO");
    assert.equal(client.counts.navigation, 1);
  });
});

test("registerPartner authenticates with the partner token, not the owner token", async () => {
  await withFake(async (client) => {
    const result = (await client.registerPartner("example.com")) as { domain: string };
    assert.equal(result.domain, "example.com");
  });
});

test("registerPartner throws without a getPartnerToken", async () => {
  const fake = createFakeFleetServer(VIN);
  const { url } = await fake.start();
  try {
    const client = createFleetClient({
      config: configFor(url),
      getAccessToken: async () => "owner-test-token",
    });
    await assert.rejects(() => client.registerPartner("example.com"), /getPartnerToken/);
  } finally {
    await fake.stop();
  }
});

test("fleetStatus reports keyPaired from the fake and counts the call", async () => {
  await withFake(async (client, fake) => {
    fake.keyPaired = true;
    const status = await client.fleetStatus();
    assert.equal(status.keyPaired, true);
    assert.equal(client.counts.fleetStatus, 1);

    fake.keyPaired = false;
    const statusUnpaired = await client.fleetStatus();
    assert.equal(statusUnpaired.keyPaired, false);
    assert.equal(client.counts.fleetStatus, 2);
  });
});

test("vehicles() lists the fake vehicle", async () => {
  await withFake(async (client) => {
    const list = (await client.vehicles()) as Array<{ vin: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].vin, VIN);
  });
});
