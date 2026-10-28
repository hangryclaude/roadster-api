# X post — Roadster API (Angus posts)

Attach: `final/roadster.mp4` (16:9, H.264). Poster frame: `final/poster.png`.

## Main post

Tesla flew the Roadster two weeks ago.

So I built it an API key.

Text your car "land on the roof."

Open source, on Tesla's official Fleet API, no hardware.
Works on every Tesla today. Flight lands the day Tesla ships the endpoint.

github.com/hangryclaude/roadster-api

## Short (quote-tweet of the unveil clip)

They made it fly. I made it text.
github.com/hangryclaude/roadster-api

## Reply thread (optional)

1. How it works: your Tesla developer app is the API key. The repo runs a self-hosted
   Tessie-compatible server on the official Fleet API. $0/month inside Tesla's $10 credit.
2. What it never does: steer, drive, summon, Autopilot. Hard-coded refusal. The flight
   commands sit in the manifest as `awaiting_fleet_api` until Tesla publishes them.
3. Airtime: hours saved over traffic, from your own drive history. Demo map in the repo.
