// Vehicle profiles: which Tesla is on the other end of the texts, decided from the VIN.
//
// The model is read from position 4 of the VIN. Tesla's current codes: S = Model S,
// 3 = Model 3, X = Model X, Y = Model Y, C = Cybertruck. R is treated as "roadster": the
// 2008 Roadster used it (WMI 5YJR), and the 2026 Roadster has no public VIN scheme yet, so
// R is the best available guess until one is published. Anything else is "unknown", which
// gets the generic profile — every live command, no flight rows.
//
// Only facts that are certain live here. Cybertruck-specific commands (tonneau cover,
// Powershare) are deliberately absent: docs/FREETESSIE-RESEARCH.md confirms Tessie exposes
// a tonneau command but not the exact Fleet API endpoint name behind it, so nothing is
// claimed until that is verified against the Fleet API reference.

import { MANIFEST, liveCommands, type ManifestEntry } from "./manifest.ts";

export type VehicleModel = "model_s" | "model_3" | "model_x" | "model_y" | "cybertruck" | "roadster" | "unknown";

export interface VehicleProfile {
  model: VehicleModel;
  // How the assistant refers to the car ("Cybertruck", "Model Y").
  name: string;
  seats: number;
  // Open cargo bed (Cybertruck) rather than a trunk.
  bed: boolean;
  // Flight commands exist in the manifest for this model (Roadster only, all awaiting_fleet_api).
  flight: boolean;
}

const PROFILES: Record<VehicleModel, VehicleProfile> = {
  model_s: { model: "model_s", name: "Model S", seats: 5, bed: false, flight: false },
  model_3: { model: "model_3", name: "Model 3", seats: 5, bed: false, flight: false },
  model_x: { model: "model_x", name: "Model X", seats: 7, bed: false, flight: false },
  model_y: { model: "model_y", name: "Model Y", seats: 5, bed: false, flight: false },
  cybertruck: { model: "cybertruck", name: "Cybertruck", seats: 5, bed: true, flight: false },
  // Seats: the Rocket variant has one, Performance and Thrust have two; two is the common case.
  roadster: { model: "roadster", name: "Roadster", seats: 2, bed: false, flight: true },
  unknown: { model: "unknown", name: "Tesla", seats: 5, bed: false, flight: false },
};

const VIN_MODEL_CODES: Record<string, VehicleModel> = {
  S: "model_s",
  "3": "model_3",
  X: "model_x",
  Y: "model_y",
  C: "cybertruck",
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
// listed only for the Roadster, so a Cybertruck owner is never offered "land".
export function commandsFor(model: VehicleModel): ManifestEntry[] {
  return profile(model).flight ? MANIFEST : liveCommands();
}
