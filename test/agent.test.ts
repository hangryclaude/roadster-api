import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../src/agent/tools.ts";

test("TOOLS never exposes autopilot/fsd/summon/speed/drive", () => {
  const banned = /autopilot|fsd|summon|speed|drive/i;
  for (const tool of TOOLS) {
    assert.ok(!banned.test(tool.name), `tool name "${tool.name}" looks banned`);
  }
});
