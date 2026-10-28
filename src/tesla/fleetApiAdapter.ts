// FleetApiAdapter: Tesla's official Fleet API implementation. Stub until Angus has
// fleet creds — the interface exists so swapping it in later touches zero call sites.
//
// Same hard rule as adapter.ts: no Autopilot/FSD/Summon/speed/drive methods here either.

import type { VehicleAdapter, VehicleState } from "./adapter.ts";

export class FleetApiAdapter implements VehicleAdapter {
  constructor(
    private readonly accessToken: string,
    private readonly vin: string,
  ) {}

  async getState(): Promise<VehicleState> {
    throw new Error("not implemented: Fleet API credentials not yet configured");
  }

  async wake(): Promise<void> {
    throw new Error("not implemented: Fleet API credentials not yet configured");
  }

  async climateOn(): Promise<void> {
    throw new Error("not implemented");
  }

  async climateOff(): Promise<void> {
    throw new Error("not implemented");
  }

  async setClimateTemp(_tempF: number): Promise<void> {
    throw new Error("not implemented");
  }

  async lock(): Promise<void> {
    throw new Error("not implemented");
  }

  async unlock(): Promise<void> {
    throw new Error("not implemented");
  }

  async chargeStart(): Promise<void> {
    throw new Error("not implemented");
  }

  async chargeStop(): Promise<void> {
    throw new Error("not implemented");
  }

  async setChargeLimit(_percent: number): Promise<void> {
    throw new Error("not implemented");
  }

  async openChargePort(): Promise<void> {
    throw new Error("not implemented");
  }

  async closeChargePort(): Promise<void> {
    throw new Error("not implemented");
  }

  async openTrunk(): Promise<void> {
    throw new Error("not implemented");
  }

  async openFrunk(): Promise<void> {
    throw new Error("not implemented");
  }

  async honkHorn(): Promise<void> {
    throw new Error("not implemented");
  }

  async flashLights(): Promise<void> {
    throw new Error("not implemented");
  }

  async sentryOn(): Promise<void> {
    throw new Error("not implemented");
  }

  async sentryOff(): Promise<void> {
    throw new Error("not implemented");
  }

  async ventWindows(): Promise<void> {
    throw new Error("not implemented");
  }

  async closeWindows(): Promise<void> {
    throw new Error("not implemented");
  }

  async navSendDestination(_address: string): Promise<void> {
    throw new Error("not implemented");
  }

  async setScheduledDeparture(_time: string, _preconditionEnabled: boolean): Promise<void> {
    throw new Error("not implemented");
  }
}
