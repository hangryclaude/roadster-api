// Vehicle profiles: which Tesla is on the other end of the texts, decided from the VIN.
//
// The model is read from position 4 of the VIN. Tesla's current codes: S = Model S,
// 3 = Model 3, X = Model X, Y = Model Y. R is treated as "roadster": the 2008 Roadster
// used it (WMI 5YJR), and the 2026 Roadster has no public VIN scheme yet, so R is the best
// available guess until one is published. Anything else is "unknown", which gets the
// generic profile — every live command, no flight rows.

import { MANIFEST, liveCommands, type ManifestEntry } from "./manifest.ts";

export type VehicleModel = "model_s" | "model_3" | "model_x" | "model_y" | "roadster" | "unknown";

export interface VehicleProfile {
  model: VehicleModel;
  // How the assistant refers to the car ("Model Y", "Roadster").
  name: string;
  seats: number;
  // Flight commands exist in the manifest for this model (Roadster only, all awaiting_fleet_api).
  flight: boolean;
}

const PROFILES: Record<VehicleModel, VehicleProfile> = {
  model_s: { model: "model_s", name: "Model S", seats: 5, flight: false },
  model_3: { model: "model_3", name: "Model 3", seats: 5, flight: false },
  model_x: { model: "model_x", name: "Model X", seats: 7, flight: false },
  model_y: { model: "model_y", name: "Model Y", seats: 5, flight: false },
  // Seats: the Rocket variant has one, Performance and Thrust have two; two is the common case.
  roadster: { model: "roadster", name: "Roadster", seats: 2, flight: true },
  unknown: { model: "unknown", name: "Tesla", seats: 5, flight: false },
};

const VIN_MODEL_CODES: Record<string, VehicleModel> = {
  S: "model_s",
  "3": "model_3",
  X: "model_x",
  Y: "model_y",
  R: "roadster",
};

export function modelFromVin(vin: string | undefined | null): VehicleModel {
  if (!vin || vin.length < 4) return "unknown";
  return VIN_MODEL_CODES[vin.charAt(3).toUpperCase()] ?? "unknown";
}

export function profile(model: VehicleModel): VehicleProfile {
  return PROFILES[model];
}

export function profileFromVin(vin: string | undefined | null): VehicleProfile {
  return profile(modelFromVin(vin));
}

// Every live manifest row applies to every model. The awaiting_fleet_api flight rows are
// listed only for the Roadster, so a Model Y owner is never offered "land".
export function commandsFor(model: VehicleModel): ManifestEntry[] {
  return profile(model).flight ? MANIFEST : liveCommands();
}
