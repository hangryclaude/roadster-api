// The Roadster command manifest: one row per thing you can text the car, with the
// variant it applies to, whether it is live today, and the Fleet API command behind it.
//
// Two kinds of row. `live` rows map 1:1 onto an existing agent tool (src/agent/tools.ts)
// and, through TessieAdapter, onto a commandMap.ts entry that becomes a signed Fleet API
// command. `awaiting_fleet_api` rows are the Roadster flight commands: Tesla showed them
// on 15 Oct 2026 but has published no Fleet API endpoint for any of them, so they route
// to the `roadster_flight` tool, which only ever answers honestly and never touches the
// vehicle adapter. When Tesla ships an endpoint, flip the row here and wire a real tool —
// subject to the same rule as everything else in this repo: nothing that drives the car.

export type RoadsterVariant = "performance" | "thrust" | "rocket";

export type CommandStatus = "live" | "awaiting_fleet_api";

export interface ManifestEntry {
  name: string;
  // An example of how you'd text it.
  say: string;
  variants: RoadsterVariant[];
  status: CommandStatus;
  // Fleet API command name (POST /api/1/vehicles/{tag}/command/<name>) or the data route;
  // null when nothing exists yet, or when the command is app-level (scheduling).
  fleetEndpoint: string | null;
  // The agent tool that implements it; null only for rows that are pure information.
  tool: string | null;
}

export const ALL_VARIANTS: RoadsterVariant[] = ["performance", "thrust", "rocket"];

const live = (
  name: string,
  say: string,
  fleetEndpoint: string | null,
  tool: string,
): ManifestEntry => ({ name, say, variants: ALL_VARIANTS, status: "live", fleetEndpoint, tool });

const flight = (name: string, say: string, variants: RoadsterVariant[]): ManifestEntry => ({
  name,
  say,
  variants,
  status: "awaiting_fleet_api",
  fleetEndpoint: null,
  tool: "roadster_flight",
});

export const MANIFEST: ManifestEntry[] = [
  // --- live today, on every Fleet-API Tesla ---------------------------------------
  live("status", "where are you", "vehicle_data", "get_vehicle_state"),
  live("warm_up", "warm it up", "command/auto_conditioning_start", "climate_on"),
  live("climate_off", "turn the heat off", "command/auto_conditioning_stop", "climate_off"),
  live("set_temp", "set it to 70", "command/set_temps", "set_climate_temp"),
  live("lock", "lock it", "command/door_lock", "lock"),
  live("unlock", "unlock it", "command/door_unlock", "unlock"),
  live("charge", "start charging", "command/charge_start", "charge_start"),
  live("stop_charge", "stop charging", "command/charge_stop", "charge_stop"),
  live("charge_limit", "charge to 80", "command/set_charge_limit", "set_charge_limit"),
  live("open_charge_port", "open the charge port", "command/charge_port_door_open", "open_charge_port"),
  live("close_charge_port", "close the charge port", "command/charge_port_door_close", "close_charge_port"),
  live("trunk", "pop the trunk", "command/actuate_trunk", "open_trunk"),
  live("frunk", "open the frunk", "command/actuate_trunk", "open_frunk"),
  live("honk", "honk", "command/honk_horn", "honk_horn"),
  live("flash", "flash the lights", "command/flash_lights", "flash_lights"),
  live("sentry_on", "sentry on", "command/set_sentry_mode", "sentry_on"),
  live("sentry_off", "sentry off", "command/set_sentry_mode", "sentry_off"),
  live("vent", "crack the windows", "command/window_control", "vent_windows"),
  live("close_windows", "close the windows", "command/window_control", "close_windows"),
  live("navigate", "send it to the office", "command/navigation_request", "nav_send_destination"),
  live("depart_at", "be ready by 7:30", "command/set_scheduled_departure", "set_scheduled_departure"),
  live("cancel_departure", "turn scheduled departure off", "command/set_scheduled_departure", "cancel_scheduled_departure"),
  live("later", "warm it up in 15", null, "schedule_action"),

  // --- the Roadster: shown 15 Oct 2026, no Fleet API endpoint yet ----------------
  flight("land", "land on the roof", ["rocket"]),
  flight("hover", "hover", ["rocket"]),
  flight("jump", "jump the traffic", ["thrust", "rocket"]),
  flight("thrust_mode", "thrusters on", ["thrust", "rocket"]),
];

export function liveCommands(): ManifestEntry[] {
  return MANIFEST.filter((e) => e.status === "live");
}

export function awaiting(): ManifestEntry[] {
  return MANIFEST.filter((e) => e.status === "awaiting_fleet_api");
}

export function forVariant(variant: RoadsterVariant): ManifestEntry[] {
  return MANIFEST.filter((e) => e.variants.includes(variant));
}

export function findEntry(name: string): ManifestEntry | undefined {
  return MANIFEST.find((e) => e.name === name);
}
