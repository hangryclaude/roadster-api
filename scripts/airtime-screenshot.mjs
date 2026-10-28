#!/usr/bin/env node
// usage: node scripts/airtime-screenshot.mjs [out.png]
// Serves web/ on a local port, opens airtime.html in headless Chrome, waits for the arcs
// and the counter to finish, and saves a 1600x1000 PNG (default ad/airtime-map.png).
// Dev-only: uses the puppeteer-core install at ~/skills (not a dependency of this repo).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.env.HOME, "skills/package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const out = process.argv[2] ?? "ad/airtime-map.png";

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const file = path.join("web", decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/airtime.html`, { waitUntil: "networkidle0", timeout: 60_000 });
  await page.waitForFunction(() => document.body.dataset.done === "1", { timeout: 30_000 });
  // tiles keep streaming in after the animation; give them a beat
  await new Promise((r) => setTimeout(r, 2500));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: "png" });
  const tiles = await page.evaluate(() => document.querySelectorAll(".leaflet-tile-loaded").length);
  console.log(`wrote ${out}; tiles loaded: ${tiles}; page errors: ${errors.length}`);
  for (const e of errors) console.log("  " + e);
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
