// FakeTessieServer: in-memory stand-in for api.tessie.com, same route shapes as
// TessieAdapter calls. Used by test/tesla's adapter tests and by scripts/e2e.ts so
// the whole stack can run without a real Tessie token or a real car.
//
// Deliberately has no route for anything Autopilot/FSD/Summon/speed/drive-adjacent —
// see SPEC.md "What this will never do." There is nothing to stub because there is
// nothing upstream calling it.

import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

export interface FakeVehicleState {
  vehicle_state: {
    odometer: number;
    locked: boolean;
    sentry_mode: boolean;
    charge_port_door_open: boolean;
    timestamp: number;
  };
  charge_state: {
    battery_level: number;
    charge_limit_soc: number;
    charging_state: "Charging" | "Stopped" | "Complete" | "Disconnected";
  };
  climate_state: {
    is_climate_on: boolean;
    inside_temp: number; // Celsius, matches Tesla/Tessie's own unit
    driver_temp_setting: number; // Celsius set-point
  };
  drive_state: {
    latitude: number;
    longitude: number;
  };
  address: string | null;
}

function defaultState(): FakeVehicleState {
  return {
    vehicle_state: {
      odometer: 47382,
      locked: true,
      sentry_mode: false,
      charge_port_door_open: false,
      timestamp: Date.now(),
    },
    charge_state: { battery_level: 54, charge_limit_soc: 90, charging_state: "Stopped" },
    climate_state: { is_climate_on: false, inside_temp: 18, driver_temp_setting: 20 },
    drive_state: { latitude: 39.7392, longitude: -104.9903 },
    address: "1900 Park Ave, Denver, CO",
  };
}

export interface FakeTessieServer {
  /** mutable so tests can assert on it or seed a scenario directly */
  state: FakeVehicleState;
  /** every command route hit, in order, for assertions like "did it call lock" */
  commandsReceived: string[];
  /** when set, the next command hitting this route name responds with result:false
   * instead of true — lets tests prove result:false is treated as a failure, not an
   * HTTP-200-therefore-success. */
  failNextCommand: string | null;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

export function createFakeTessieServer(vin = "TEST000000000VIN"): FakeTessieServer {
  const state = defaultState();
  const commandsReceived: string[] = [];
  const fake: { failNextCommand: string | null } = { failNextCommand: null };
  let server: ServerType | undefined;

  const app = new Hono();

  function resultFor(name: string): { result: boolean } {
    if (fake.failNextCommand === name) {
      fake.failNextCommand = null;
      return { result: false };
    }
    return { result: true };
  }

  app.get(`/${vin}/state`, (c) => c.json(state));

  app.post(`/${vin}/command/wake`, (c) => c.json(resultFor("wake")));

  app.post(`/${vin}/command/lock`, (c) => {
    commandsReceived.push("lock");
    const r = resultFor("lock");
    if (r.result) state.vehicle_state.locked = true;
    return c.json(r);
  });
  app.post(`/${vin}/command/unlock`, (c) => {
    commandsReceived.push("unlock");
    const r = resultFor("unlock");
    if (r.result) state.vehicle_state.locked = false;
    return c.json(r);
  });

  app.post(`/${vin}/command/start_climate`, (c) => {
    commandsReceived.push("start_climate");
    state.climate_state.is_climate_on = true;
    return c.json(resultFor("start_climate"));
  });
  app.post(`/${vin}/command/stop_climate`, (c) => {
    commandsReceived.push("stop_climate");
    state.climate_state.is_climate_on = false;
    return c.json(resultFor("stop_climate"));
  });
  app.post(`/${vin}/command/set_temperatures`, (c) => {
    commandsReceived.push("set_temperatures");
    const temperature = c.req.query("temperature");
    if (temperature) {
      state.climate_state.inside_temp = Number(temperature);
      state.climate_state.driver_temp_setting = Number(temperature);
    }
    return c.json(resultFor("set_temperatures"));
  });

  app.post(`/${vin}/command/start_charging`, (c) => {
    commandsReceived.push("start_charging");
    state.charge_state.charging_state = "Charging";
    return c.json(resultFor("start_charging"));
  });
  app.post(`/${vin}/command/stop_charging`, (c) => {
    commandsReceived.push("stop_charging");
    state.charge_state.charging_state = "Stopped";
    return c.json(resultFor("stop_charging"));
  });
  app.post(`/${vin}/command/set_charge_limit`, (c) => {
    commandsReceived.push("set_charge_limit");
    const percent = c.req.query("percent");
    if (percent) state.charge_state.charge_limit_soc = Number(percent);
    return c.json(resultFor("set_charge_limit"));
  });
  app.post(`/${vin}/command/open_charge_port`, (c) => {
    commandsReceived.push("open_charge_port");
    state.vehicle_state.charge_port_door_open = true;
    return c.json(resultFor("open_charge_port"));
  });
  app.post(`/${vin}/command/close_charge_port`, (c) => {
    commandsReceived.push("close_charge_port");
    state.vehicle_state.charge_port_door_open = false;
    return c.json(resultFor("close_charge_port"));
  });

  app.post(`/${vin}/command/activate_rear_trunk`, (c) => {
    commandsReceived.push("activate_rear_trunk");
    return c.json(resultFor("activate_rear_trunk"));
  });
  app.post(`/${vin}/command/activate_front_trunk`, (c) => {
    commandsReceived.push("activate_front_trunk");
    return c.json(resultFor("activate_front_trunk"));
  });

  app.post(`/${vin}/command/honk`, (c) => {
    commandsReceived.push("honk");
    return c.json(resultFor("honk"));
  });
  app.post(`/${vin}/command/flash`, (c) => {
    commandsReceived.push("flash");
    return c.json(resultFor("flash"));
  });

  app.post(`/${vin}/command/enable_sentry`, (c) => {
    commandsReceived.push("enable_sentry");
    state.vehicle_state.sentry_mode = true;
    return c.json(resultFor("enable_sentry"));
  });
  app.post(`/${vin}/command/disable_sentry`, (c) => {
    commandsReceived.push("disable_sentry");
    state.vehicle_state.sentry_mode = false;
    return c.json(resultFor("disable_sentry"));
  });

  app.post(`/${vin}/command/vent_windows`, (c) => {
    commandsReceived.push("vent_windows");
    return c.json(resultFor("vent_windows"));
  });
  app.post(`/${vin}/command/close_windows`, (c) => {
    commandsReceived.push("close_windows");
    return c.json(resultFor("close_windows"));
  });

  app.post(`/${vin}/command/share`, (c) => {
    commandsReceived.push(`share:${c.req.query("value") ?? ""}`);
    return c.json(resultFor("share"));
  });

  app.post(`/${vin}/command/schedule_departure`, (c) => {
    commandsReceived.push("schedule_departure");
    return c.json(resultFor("schedule_departure"));
  });

  return {
    state,
    commandsReceived,
    get failNextCommand() {
      return fake.failNextCommand;
    },
    set failNextCommand(v: string | null) {
      fake.failNextCommand = v;
    },
    start(): Promise<{ port: number; url: string }> {
      return new Promise((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => {
          resolve({ port: info.port, url: `http://127.0.0.1:${info.port}` });
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
