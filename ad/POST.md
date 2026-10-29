# X post — Roadster API (Angus posts)

Attach: `final/roadster_v4.mp4` (50 s, 16:9, H.264). Poster frame: `final/poster_v3.png`. Music is the TikTok sound "3 Strikes" (Andree Son) from the reference edit: fine as a TikTok sound, not cleared for X; swap to music/bed.mp3 (Sonilo, ours) if posting on X with audio matters.

## Main post

Tesla flew the Roadster two weeks ago.

So I built it an API key.

"fly the kids to school."

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
3. The flight shots are generated from frames of the real unveil car (the school fly-in and the freeway glide)
   and checked against them side by side. Concept film, and the end card says so.
