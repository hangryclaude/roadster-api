// usage: npm run airtime -- --demo            (synthetic LA commutes from data/airtime-demo.json)
//        npm run airtime                      (your car: freetessie's history store)
//        npm run airtime -- --cruise-kph 200 --overhead-s 90
//
// Writes web/airtime-data.json (summary + GeoJSON arcs) and web/airtime-data.js (the same
// object on window.AIRTIME so web/airtime.html also works straight off the filesystem).
// Open web/airtime.html through any static server, e.g. `npx serve web`.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHistoryRecorder } from "../src/freetessie/history.ts";
import { DEFAULT_CRUISE_MPS, DEFAULT_OVERHEAD_SECONDS, summarize, toGeoJson, type Drive } from "../src/roadster/airtime.ts";
import { drivesFromHistory } from "../src/roadster/airtimeHistory.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const demo = args.includes("--demo");
const cruiseKph = flag("--cruise-kph");
const overheadS = flag("--overhead-s");
const opts = {
  cruiseMps: cruiseKph ? (Number(cruiseKph) * 1000) / 3600 : DEFAULT_CRUISE_MPS,
  overheadSeconds: overheadS ? Number(overheadS) : DEFAULT_OVERHEAD_SECONDS,
};

let drives: Drive[];
let source: string;
if (demo) {
  const file = path.resolve("data/airtime-demo.json");
  drives = (JSON.parse(fs.readFileSync(file, "utf8")) as { drives: Drive[] }).drives;
  source = "demo";
} else {
  const dbPath = process.env.FREETESSIE_DB_PATH ?? "freetessie.db";
  if (!fs.existsSync(dbPath)) {
    console.error(`no history yet: ${dbPath} does not exist. Run the server first, or use --demo.`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  try {
    drives = drivesFromHistory(createHistoryRecorder(db));
  } finally {
    db.close();
  }
  source = dbPath;
}

const summary = summarize(drives, opts);
const out = { source, generatedAt: new Date().toISOString(), summary, arcs: toGeoJson(drives, opts) };
fs.mkdirSync("web", { recursive: true });
fs.writeFileSync("web/airtime-data.json", JSON.stringify(out, null, 1) + "\n");
fs.writeFileSync("web/airtime-data.js", `window.AIRTIME = ${JSON.stringify(out)};\n`);
console.log(
  `${summary.totals.drives} drives, ${summary.totals.km.toFixed(0)} km straight-line, ` +
    `${summary.totals.savedHours.toFixed(1)} hours saved over traffic ` +
    `(assuming ${summary.assumptions.cruiseKph} km/h cruise + ${summary.assumptions.overheadSeconds} s per flight — hypothetical)`,
);
console.log("wrote web/airtime-data.json, web/airtime-data.js");
