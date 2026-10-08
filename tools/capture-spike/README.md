# icom-capture-spike

Phase 0 research tool for `signalk-m510e-connector`. **Not the plugin** — a
throwaway script to run on the boat's WiFi next to a real IC-M510E, to answer
the open questions from the project plan before writing any plugin code.

It joins the radio's session as a 4th silent client (alongside any real
RS-M500 phone apps in use), and logs everything it can about:

- discovery / sign-in / keepalive behaviour
- channel status changes (the "busy" squelch flag, used here as transmission
  start/end boundaries)
- the raw voice/RTP UDP stream, saved per-transmission

All protocol details are taken from
[htool/signalk-icom-m510e-plugin](https://github.com/htool/signalk-icom-m510e-plugin)
and [htool/signalk-icom-ct-m500-plugin](https://github.com/htool/signalk-icom-ct-m500-plugin)
— unofficial reverse engineering, not an Icom spec. Treat this script as
likely to need patching after the first real run.

## Setup

```
npm install
```

## Running it on the boat

Connect your laptop to the same WiFi network the M510E is on or is
broadcasting (SSID from the radio's own settings, or the boat's shared
WiFi if the radio joined that instead — check the radio's WLAN menu if
unsure).

```
node index.js --out ./captures --bind <your-laptop-ip-on-that-network>
```

Use `--bind` explicitly if your laptop has more than one active interface
(e.g. a wired boat LAN plus the WiFi hotspot) — otherwise the `ip` package's
auto-detected address may be the wrong one and discovery will silently never
find the radio.

Let it run, then:
1. Key up on a few different channels from a handheld or another station,
   confirm they show up as `tx-start` / `tx-end` events.
2. Try transmitting from the M510E's own PTT mic and watch for whether
   `voice-packet` events fire during your own transmission — this answers
   the "is TX audio visible on WiFi" question.
3. Try it with a real RS-M500 phone app connected at the same time, confirm
   the app isn't disrupted.

Stop with Ctrl-C — it flushes and closes cleanly.

## What to do with the output

- **`session.jsonl`** — one JSON object per line, full event history.
  Grep for `"type":"tx-start"` / `"type":"tx-end"` to get a quick list of
  detected transmissions with duration and packet counts.
- **`voice/<n>-<timestamp>.raw`** — the concatenated raw UDP payloads for
  transmission number `n`. This is *not* a playable audio file yet — it's
  raw RTP packets back-to-back, deliberately undecoded.

### Identifying the codec — RX answered (v1), TX/hailer still open (v2)

`capture.sanitized.pcap` (RX audio ↔ WiFi app session, port 50001) confirms
the M510E/CT-M500 sends plain RTP with **payload type 0 — PCMU/G.711
µ-law** at 8kHz mono, no Icom-proprietary vocoder:

- RTP header: standard 12 bytes (`V=2, PT=0`), sequence +1 per packet,
  timestamp +320 per packet.
- 320 bytes of µ-law payload per packet → 320 samples at 8kHz = 40ms
  frames, matching the ~40ms inter-packet gap.
- SSRC and RTCP (port 50002, sender reports + SDES) also follow plain
  RTP/RTCP, not a custom framing.

Decode with `ffmpeg -f mulaw -ar 8000 -ac 1 -i payload.raw out.wav`, or see
`rtp.payloadType` in `voice-packet`/`tx-end` events for confirmation on your
own capture — should read `0` for RX audio.

`capture.sanitized.pcap` is only ~10s and doesn't contain a TX or hailer/PA
transmission, so those codecs are still unidentified — not a v1 blocker
(TX/hailer logging is v2 scope), but worth resolving whenever a longer
capture is available. Re-run this script capturing a TX and (if possible)
a hailer/PA transmission, then check `rtp.payloadType` for those streams
the same way: PT 0/8 means standard PCMU/PCMA, a dynamic type (96–127)
means a different codec that will need separate identification.

### Sanity-checking the busy-flag boundaries

Compare `tx-start`/`tx-end` timestamps in `session.jsonl` against your own
notes of when you actually kept the PTT down. If there's a consistent lag
or the flag chatters (rapid start/end/start), that changes how Phase 1
should trim clips — e.g. debounce the busy flag rather than trusting it
directly.

**Found and fixed via `capture.sanitized.pcap` replay**: `lib/radioClient.js`
used to track busy as a single boolean with no awareness of which channel a
status packet is about. In the sample capture, the radio's status responses
alternate between channel index 84 and index 93 (channels 28 and 31, a dual-watch/scan), and each
switch to 93 used to read as squelch-closed; a genuine ~50ms squelch blip
between syllables on the active channel (84) itself caused the same problem.
Replaying the capture used to produce 3 separate `tx-start`/`tx-end` cycles
for one continuous ~7.4s RX transmission, even though no RTP packets were
actually lost. `RadioClient` now keys busy-tracking off the channel index and
debounces a not-busy reading on the active channel (`busyDebounceMs`,
default 200ms) — see `test/pcap-replay.test.js` and
`test/radioClient.test.js` for the regression coverage. Still worth
re-checking against a live radio once hardware is available, since the
200ms debounce default is a guess from this one capture, not tuned data.

## Sample capture

`capture.sanitized.pcap` is a real ~10s WiFi capture of an M510E session
(login handshake on port 50003, NMEA0183 GPS forwarding on port 50004, RTP
voice on port 50001, RTCP on port 50002) — see above for what it shows about
the codec. GPS fix and both MAC addresses are pseudonymized; the real
values are kept in a private repo's mapping record, not here.

## Known limitations of this script (intentional, for a Phase 0 spike)

- Single radio only — doesn't handle a boat with two M510Es.
- No reconnect/resilience logic — if the radio reboots or drops WiFi,
  restart the script.
- No channel-name resolution (that requires the channel-table request
  sequence from the full plugin) — transmissions are logged with a raw
  channel number, not a friendly name.
- Doesn't touch NMEA0183/DSC correlation — that's Phase 3 in the project
  plan, and needs the working codec/clip pipeline first.
