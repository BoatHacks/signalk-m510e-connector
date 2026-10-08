# signalk-m510e-connector

Records incoming VHF transmissions from an Icom IC-M510E / CT-M500 over
WiFi, as a searchable SignalK log — a "black box" for the radio. Outgoing
(TX/PTT and hailer) audio logging is a v2 feature; v1 is RX-only.

## Status

**v0.1.3, RX recording works against a live IC-M510E.** The plugin signs
in to the radio over WiFi, records each received transmission (raw RTP and
a WAV), stores it in SQLite with its channel and channel mode, and serves
it through the REST routes and the webapp (play, download, transcribe).
Checked live on 2026-10-08 on channels 6 and 68.

Known issues:

- The radio's own transmissions (its PTT) do not reach WiFi clients as
  status or voice, so only received audio is recorded. TX is v2 scope.
- After a Signal K restart the radio sometimes ignores new sign-ins, or
  sends heartbeats but no status or voice, until the radio is rebooted. The
  plugin logs each resend and failure, the admin UI plugin status shows
  the sign-in state, and a session with no heartbeat for 15s is reported
  and restarted from discovery after 60s. The cause is not known.
- "Mayday" is still transcribed unreliably in isolation (see Known
  limitation below).

The protocol is reverse-engineered, not an Icom spec; see
[Phase 0](#phase-0--research-spike-in-progress) below.

## Background

The M510E and CT-M500 have no published protocol documentation from Icom.
Everything known about how they talk over WiFi comes from unofficial
reverse engineering by GitHub user [htool](https://github.com/htool):

- [signalk-icom-m510e-plugin](https://github.com/htool/signalk-icom-m510e-plugin)
  — channel read/control, posing as an RS-M500 app session
- [signalk-icom-ct-m500-plugin](https://github.com/htool/signalk-icom-ct-m500-plugin)
  — emulates the CT-M500 box itself, injecting NMEA0183/AIS/DSC sentences

This plugin builds on the same discovery/sign-in/keepalive groundwork
(UDP broadcast on port 50000, `"Icom"`-magic-byte packet headers, per-role
client identity strings), extended to capture the voice/RTP stream and
log transmissions rather than control the radio.

## Project plan

### Phase 0 — research spike (in progress)

Open questions that need a real M510E to answer, before the plugin's
actual recording logic can be designed. #1, #3, #4 block v1 (RX-only);
#2 and #5 are v2 (outgoing TX/PTT and hailer audio) and don't block v1:

1. **Answered.** RX voice codec is plain RTP, payload type 0 (PCMU/G.711
   µ-law) — see [`tools/capture-spike`](tools/capture-spike) and the
   Phase 0 findings in [CHANGELOG.md](CHANGELOG.md).
2. *(v2)* Is outgoing (PTT mic) audio visible on WiFi at all, or only
   received traffic?
3. Does a 4th silent client signing in alongside real RS-M500 app
   sessions disrupt the radio?
4. How clean is the busy/squelch flag as a transmission start/end
   boundary? A replay of the sample capture against `lib/radioClient.js`
   shows a single continuous RX transmission getting fragmented into 3
   separate `tx-start`/`tx-end` cycles, because the radio's status
   responses alternate between two channel numbers (dual-watch/scan) and
   each switch reads as squelch-closed even though no audio was lost.
   Needs fixing before Phase 1 can trust its clip boundaries.
5. *(v2)* Hailer/PA is a different audio path than ship's VHF — does
   hailer/RX-hailer audio transit the WiFi link at all (same voice/RTP
   port, a separate port, or is it entirely analog on the CT-M500's own
   circuitry with nothing to capture over WiFi)? The CT-M500 plugin only
   ever decoded horn on/off/volume *control* messages, never audio for
   it — this may end up being metadata-only, same open question as #2.

A standalone capture tool for this lives at
[`tools/capture-spike`](tools/capture-spike) — joins the radio as a
silent 4th client and dumps raw voice/RTP traffic plus channel-status
events for analysis. It's deliberately kept separate from the plugin
itself (own `package.json`, own dependencies) since it's throwaway
research tooling, not part of the plugin's runtime.

### Phase 1 — RX-only MVP

**Backend implemented** (`lib/radioClient.js`, `lib/db.js`, `lib/retention.js`)
and **validated against a live radio** on 2026-10-08: sign-in succeeds,
the busy flag opens and closes with the squelch, clips play back, and the
channel numbers match the radio's display (the status frame carries a
channel-set index, `channel*3 + mode`, not a channel number).

- Discovery/sign-in/keepalive client, own module (no longer duplicated
  research-script code) — `RadioClient` in `lib/radioClient.js`.
- RX transmissions captured to disk as **two files each**, written once
  at capture time (`lib/rtpAudio.js`, bounded by the busy flag —
  `lib/protocol.js` for the packet-level parsing): the raw,
  length-prefix-framed RTP packets (forensic — exact captured bytes,
  undecoded) and a decoded WAV, sharing a basename
  (`<startTs>-ch<channelNr>.raw`/`.wav`). An earlier version decoded to
  WAV on every `/audio` request instead of storing one — reverted after
  it turned out not to play reliably in the browser (`res.send(buffer)`
  has no Range-request support, which some `<audio>` implementations
  need); `res.sendFile()` on a real file on disk does.
- `node:sqlite` index (`lib/db.js`): direction, channel, start/end
  timestamp, duration, audio path, `file_bytes` (raw + WAV size on disk),
  channel mode, squelch, vessel position at start (best-effort from
  `navigation.position`).
- Retention enforcement (`lib/retention.js`) wired in after every
  capture — deletes both files together.
- REST surface live: `GET /status`, `GET /transmissions` (filterable by
  channel/time range/direction), `GET /transmissions/:id`,
  `GET /transmissions/:id/audio` (serves the stored WAV directly).
- No UI yet (see Phase 2).

### Phase 2 — SignalK surface + UI

- `GET /transmissions`, `GET /transmissions/:id`,
  `GET /transmissions/:id/audio` — done (Phase 1).
- **Buildless Preact+htm webapp implemented** (`public/`; vendored
  dependencies, no CDN — matches [[signalk-stowage-mgmt]] and the rest of
  the BoatHacks plugins): sortable/filterable transmission table (start
  time, channel, duration, direction, position, size), filter by channel
  number and date range, inline playback via a bottom player bar, WAV
  download per row, live radio-connection indicator and clock in a header band, day/night
  mode in the style of signalk-status-tiles (dark in both modes, flat panels
  with corner brackets; follows `environment.mode` unless the toggle is used). Play, Download and Transcribe were checked
  against real recordings on the live server.
- `communication.vhf.recording.status` SignalK path — done: emits
  `'recording'`/`'idle'` via `app.handleMessage` on `tx-start`/`tx-end`
  (and an initial `'idle'` on plugin start). Custom, non-spec path —
  nothing in the core SignalK schema covers this.

### Phase 3 — enrichment

- Correlate DSC sentences (via the NMEA0183 receive path from
  `signalk-icom-ct-m500-plugin`) so distress/individual calls show the
  calling MMSI against the relevant clip.
- Auto-tag entries (e.g. Ch16 distress/urgency from the DSC category
  field).

### v2 — outgoing audio

- TX (PTT mic) and hailer/PA transmission logging, once Phase 0's open
  questions #2 and #5 above are answered. Not part of v1.

### Phase 4 — retention & polish

- Configurable retention (days or max disk size), oldest-first pruning —
  done.
- Export a date range as a zip — not started.
- **Optional speech-to-text — done.** `POST /transmissions/:id/transcribe`
  sends a recording's decoded audio to a Wyoming ASR service (e.g.
  [signalk-whisper](https://github.com/hoeken/signalk-whisper) via an
  optional [signalk-wyoming](https://github.com/hoeken/signalk-wyoming)
  installation) and stores the returned transcript. Set `asrUri` in the
  plugin config to enable it (`tcp://host:port`, e.g.
  `tcp://localhost:10300` if signalk-wyoming manages whisper locally) —
  empty by default, and nothing else in this plugin depends on it. This
  plugin never runs a speech model itself (still true to the original
  "most SignalK hosts are Pi-class hardware" concern) — it only talks
  Wyoming-protocol TCP to a service that's already running. signalk-wyoming's
  own REST API only transcribes *live* mic recordings (`POST
  /plugins/signalk-wyoming/api/transcribe`), not already-recorded audio, so
  this plugin talks to the underlying ASR service directly instead — see
  `lib/wyomingClient.js`/`lib/wyomingProtocol.js`.

#### Known limitation: standard VHF prowords transcribe poorly on the default model

Tested end to end against a real Piper + whisper (`tiny-int8`) install: a
phrase like *"Vessel traffic Dover, this is motor vessel Curlew, request
permission to enter the channel"* transcribes with ~90%+ word accuracy. But
the three internationally standardized distress/urgency/safety prowords
come through badly:

- **"Mayday."** alone → *"Nade."*, every time.
- **"Securite."** alone → *"Take your it." / "Secure it."*
- **"Pan-pan pan-pan pan-pan."** (the standard triple) can trigger a
  Whisper repetition-loop bug — one run produced the word "pan" ~100 times.

Root cause, not a guess: `faster-whisper`/`wyoming-faster-whisper` takes an
`--initial-prompt` string that biases its vocabulary, but it's a **server
startup flag**, not something a client can set per request — the Wyoming
`transcribe` event's `context`/`name` fields exist in the protocol but this
server implementation (`dispatch_handler.py`) only reads `language` from
them. A shared whisper instance's `--initial-prompt` is commonly tuned for
a *different* voice-command use case (e.g. sail trim / rig / engine
vocabulary for a boat-assistant plugin) and typically contains no VHF
procedure words at all, which pushes the model further away from
recognizing them.

**Recommended fix**: extend that shared instance's `--initial-prompt` to
include VHF prowords — cheap, no new container, and it's exactly the
mechanism `wyoming-faster-whisper`'s own vocabulary-biasing design expects
to be used for domain-specific terms. If you're running
[signalk-whisper](https://github.com/hoeken/signalk-whisper), its plugin
config has an **Initial prompt** field — append this to whatever's already
there (comma-separated, same sentence):

```text
Mayday, Pan-pan, Securite, roger, over, out, radio check, all stations, coast guard, distress, MMSI.
```

Keep the existing terms in front of it — Whisper's prompt is used in
priority order and is silently truncated well before any hard length
limit, so appending (not replacing) keeps both vocabularies working. Two
things confirmed by `wyoming-faster-whisper`'s own `vocabulary.py`: the
prompt budget is capped around 200 tokens (roughly 2.95 characters/token
for a comma-joined name list), and a too-long prompt makes the model
hallucinate/echo words that were never said — so don't just keep bolting
more phrases onto this indefinitely.

If a shared instance isn't an option, the fallback is a second,
VHF-dedicated whisper container with its own prompt, or a larger model
(`base`/`small` instead of `tiny-int8`) — bigger models generally need
less prompt-biasing for rare/loanwords, at higher RAM cost. Both are
heavier than the prompt fix and untested here.

**This fix was applied and confirmed to help**, on this project's own
test host: same phrases, before vs. after extending the shared instance's
prompt with the snippet above (container recreated, not just restarted,
since `--initial-prompt` is fixed at container creation):

| Phrase | Before | After |
| --- | --- | --- |
| "Mayday." | "Nade." every time | "Mayday." roughly half the time, phonetically-close misses otherwise — never "Nade" again |
| "Securite securite securite." | inconsistently garbled | "Securite, Securite, Securite, Securite." — exactly right, both re-test runs |
| "Pan-pan pan-pan pan-pan." | one run hallucinated ~100 repeats of "pan" | worst case 7 repeats, best case exactly right — the runaway loop is gone |

Not a full fix — isolated "Mayday" is still the weakest case — but a
real, measurable improvement from a one-line config change.

Test audio for these phrases (before/after the resample/mu-law round-trip
that a real recording goes through) is in
[`scripts/examples/`](scripts/examples), generated by
[`scripts/generate-test-audio.js`](scripts/generate-test-audio.js) — run
it yourself against your own Piper install to compare.

#### A second issue: our own test audio was mispronouncing "Securite"

"Securite" is French in origin, and the real on-air pronunciation — per
ITU-R radiotelephony convention — sounds like **"say-curie-tay"**, not
how an English voice reads the written word letter-by-letter. Piper's
`en_US` voice was doing the latter, so every "Securite" test phrase in
this section up to here was itself mispronounced, independent of
whisper's vocabulary bias. `scripts/generate-test-audio.js` (and the
regenerated `scripts/examples/securite-triple-*.wav`) now sends Piper
the phonetic spelling for synthesis while keeping "Securite" as the
canonical spelling everywhere else (labels, notes, DB `text` fields) —
see the `synthesisText` field on that script's `securite-triple` case.

Recognition accuracy with the corrected pronunciation is comparable to
before, not dramatically better — isolated "Say-curie-tay." still comes
back correct only about half the time (*"Securite,"* / *"Take your
retake."*, similar variance to the mispronounced version), and the
tripled form still over-repeats (*"Securite, security, security,
security, security."*). The real point isn't a recognition-accuracy
lever — it's that the test audio itself is now phonetically realistic,
representative of what actually comes over a real VHF radio, rather than
testing against a pronunciation nobody would ever say on-air.

## Scope decisions

- **Compliance-grade log vs personal convenience tool: undecided.**
  Whether this needs to double as an immutable, exportable record (the
  kind commercial/GMDSS record-keeping expects) or is just a personal
  incident-review tool is still open. Leaning the data model toward
  immutability-friendly now (append-only, no destructive edit of a
  logged clip's core fields) costs little and keeps both options open —
  retrofitting that guarantee later would be much harder than relaxing
  it later if it turns out convenience is all that's needed.
- **No real-time alerting.** This plugin only logs, after the fact.
  Surfacing distress/urgency calls live (SignalK notifications, etc.)
  is explicitly out of scope — that's [[signalk-notification-dispatcher]]'s
  job, not this plugin's. If DSC correlation (Phase 3) reveals a
  distress call, this plugin records it richly; it does not alert
  anyone.
- **Hailer/PA and TX (outgoing) audio are v2 scope**, not v1 — see the
  open Phase 0 questions above about whether either is even visible
  over WiFi.
- **Fully standalone — no dependency on `signalk-icom-m510e-plugin`.**
  This plugin implements its own discovery/sign-in/keepalive client
  rather than reusing or requiring that plugin's session. Simpler
  install, no coupling between two plugins' radio sessions.
- **Retention is configurable two ways, independently: by age (days)
  and by total log directory size.** Whichever limit is hit first
  prunes oldest-first. Either can be set to unlimited.
- **TX-less logging is acceptable for v1.** Outgoing (TX/PTT and
  hailer/PA) audio moved to v2, see above.
- **Final project name: `signalk-m510e-connector`.**

## Development

```
npm install
npm test
```

## License

MIT
