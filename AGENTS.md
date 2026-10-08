@no-slop.md

# signalk-m510e-connector

Planned SignalK plugin that records incoming radio transmissions from the
Icom IC-M510E/CT-M500 (RX-only for v1; TX/hailer is v2 — see Scope
decisions). Package/plugin id and the GitHub repo itself both renamed from
`signalk-icom-radio-log` to `signalk-m510e-connector`
(BoatHacks/signalk-m510e-connector, public).

## Phased plan
Phase 0: hardware research spike (codec identification, multi-client
behavior, busy-flag accuracy for v1; TX-audio/hailer availability deferred
to v2) — done via a standalone tool, not the plugin itself (see below). RX
codec identified: plain RTP, payload type 0 (PCMU/G.711 µ-law),
320-byte/40ms frames — no proprietary Icom vocoder, decodable with any
standard library. Busy-flag replay finding, fixed: a single continuous RX
transmission used to fragment into 3 separate `tx-start`/`tx-end` cycles in
`lib/radioClient.js`, because the radio dual-watches/scans two channel
numbers (each switch read as squelch-closed) and a genuine ~50ms squelch
blip between syllables on the active channel did too. `RadioClient` now
keys busy-tracking off the channel index (channel*3+mode; the status frame carries an index, not a channel number, so what looked like channels 84/93 in the 2023 capture are channels 28/31) and debounces a not-busy reading on the
active channel (`busyDebounceMs`, default 200ms — a guess from this one
capture, worth re-tuning against real hardware). `parseChannelStatus` also
fixed: the real 28-byte packets on port 50003 aren't truncated status
packets, they're a distinct ack/heartbeat response (byte `[17] === 0x01`);
the function now checks that type byte instead of only inferring shape
from length. TX/hailer codec is v2 scope, not blocking.
Phase 1: RX-only MVP with SQLite storage.
Phase 2: REST endpoints + Preact/htm frontend (style like
signalk-stowage-mgmt).
Phase 3: enrichment via DSC/NMEA0183 correlation.
Phase 4: retention (done) / export (not started) / optional speech-to-text
via an external Wyoming ASR service (done — see below; this plugin never
runs a speech model itself, only talks Wyoming-protocol TCP to one that's
already running).
v2: TX (PTT mic) and hailer/PA transmission logging.

## Scope decisions
- Compliance-grade log vs. pure convenience tool: not yet decided, so the data
  model is designed to be append-only/immutable-leaning either way.
- No real-time alerting on distress calls — that's
  [[signalk-notification-dispatcher]]'s job; this plugin only logs.
- TX-less logging is acceptable for v1 — hailer/PA and outgoing (TX) audio
  from the CT-M500 moved to v2.
- Runs fully standalone, no dependency on signalk-icom-m510e-plugin.
- Retention configurable both by age (days) and by total log-directory size
  (`retentionMaxSizeMB`), independently — whichever limit is hit first deletes
  oldest entries first.
- Final project name: `signalk-m510e-connector`.

## Current state (Phase 1 backend + Phase 2 webapp implemented, not yet
validated against real hardware)
- `tools/capture-spike/` — the Phase-0 research tool (`icom-capture-spike`,
  own package.json/deps, not part of the plugin runtime): a standalone Node
  script that logs in as a silent fourth client to the M510E and captures raw
  voice/RTP traffic for codec analysis. Includes `capture.sanitized.pcap`, a
  real sample capture (GPS fix and MACs pseudonymized) confirming the RX
  codec finding above.
- `lib/protocol.js` — pure, tested packet encode/decode helpers.
- `lib/radioClient.js` — `RadioClient` EventEmitter for
  discovery/sign-in/keepalive/busy-flag-tracking/RX-voice-capture, no file I/O.
- `lib/db.js` — `node:sqlite` transmissions table.
- `lib/retention.js` — age- and size-based pruning.
- `lib/rtpAudio.js` — RTP packet framing (raw/forensic on-disk storage)
  and RTP/PCMU → WAV decoding. Both the raw file and the decoded WAV are
  written once, at capture time (`finishTransmission`) — reverted from an
  earlier on-demand-per-request decode after live testing found it didn't
  play reliably (`res.send(buffer)` has no Range support; `res.sendFile()`
  on a real file does). `rawPathToWavPath()` derives one path from the
  other so retention can delete the pair without a second DB column.
- `lib/wyomingProtocol.js` — minimal, self-contained Wyoming wire framing
  (encode/decode). Not a dependency on `signalk-wyoming/protocol` — that
  package isn't on npm yet, and its own DEVELOPERS.md says sibling plugins
  embed a tiny reimplementation for production use rather than depend on
  it; same choice here.
- `lib/wyomingClient.js` — `transcribeAudio()`: sends PCM straight to a
  Wyoming ASR service over raw TCP (transcribe → audio-start →
  audio-chunk(s) → audio-stop → transcript), bypassing signalk-wyoming's
  own REST API entirely, since that API (`POST
  /plugins/signalk-wyoming/api/transcribe`) only records *live* from a
  satellite mic — there's no documented way to hand it audio that's
  already been recorded.
- `index.js` wires it together; `/status`, `/transmissions`,
  `/transmissions/:id`, `/transmissions/:id/audio` return real data;
  `POST /transmissions/:id/transcribe` calls the above (501 if `asrUri`
  isn't configured, 503 if the service is unreachable/errors) and
  persists the result via `db.setTranscript`; emits
  `communication.vhf.recording.status` (`'recording'`/`'idle'`) via
  `app.handleMessage` on `tx-start`/`tx-end`/start/stop — the last open
  Phase 2 item, now done.
- `public/` — buildless Preact+htm webapp (vendored, no CDN): sortable/
  filterable transmission table, inline playback, WAV download, live
  status pill, light/dark theme, and now a per-row Transcribe button
  (shows the stored transcript once done, a re-transcribe icon after that,
  or an error indicator on failure). Verified interactively against a mock
  API server via a headless Chromium + puppeteer-core script (not
  committed — one-off verification, not project tooling), including the
  transcribe success/already-transcribed/failure cases; not yet run
  against the real plugin/database.
- Minimum Node version raised to 22.5.0 because of `node:sqlite`.
- 43 tests total; this sandbox's Node 20 can't load `lib/db.js`
  (`node:sqlite`), so `db.test.js`/`retention.test.js`/`plugin.test.js`
  fail here directly — confirmed pre-existing against unmodified `main`,
  not a regression. Verified the recording-status and transcribe-route
  wiring anyway via a throwaway in-process `DatabaseSync` shim (not
  committed) good enough to let `plugin.test.js` run; not a substitute for
  the real thing on Node ≥22.5.0. `lib/wyomingClient.js` is tested against
  a real mock Wyoming TCP server (`test/wyomingClient.test.js`) — success,
  ignored intermediate events, service errors, connection-refused, and
  timeout are all covered.
- **Verified end to end against the real Piper + whisper containers running
  on this host.** Piper-synthesized test phrases (resampled to 8kHz,
  mu-law encoded, framed as fake RTP packets matching the real M510E's
  wire format) run through the exact frame/unframe/decode path production
  code uses, then transcribed by the real whisper `tiny-int8` container.
  General maritime phraseology transcribed at ~70-92% word overlap
  (mostly Whisper's own number/punctuation normalization, not real
  errors). Found a real, safety-relevant gap: "Mayday"/"Securite"
  transcribe badly even in isolation, and a tripled "Pan-pan" can trigger
  a Whisper repetition-loop bug. Root cause confirmed by reading
  `wyoming-faster-whisper`'s `dispatch_handler.py`: the ASR service's
  `--initial-prompt` vocabulary-biasing is a server startup flag, not
  settable per request over Wyoming (the protocol's `transcribe.context`
  field exists but this server ignores it, honoring only `language`), and
  the shared instance on this host had zero VHF vocabulary in its prompt
  — see README.md's "Known limitation" section for the recommended fix
  and CHANGELOG.md's "Known limitations" for the full writeup.

  **Fix applied and verified.** Extended
  `/home/pi/.signalk/plugin-config-data/signalk-whisper.json`'s
  `initialPrompt` with VHF prowords (backed up to the session scratchpad
  first), then recreated the `sk-whisper` container (`podman stop`/`rm`/
  `run` with the same image/mounts/ports/limits and the new
  `--initial-prompt` baked in — a plain `podman restart` would *not* have
  picked it up, since Cmd args are fixed at container creation) with the
  user's explicit go-ahead for this specific action. Re-ran the isolation
  test (an ancestor of what's now `scripts/generate-test-audio.js` +
  `scripts/examples/`, committed) against the recreated container:

  | Phrase | Before | After (2 runs) |
  | --- | --- | --- |
  | "Mayday." | "Nade." (every time) | "Mayday." / "Neide," — correct about half the time, phonetically-close otherwise, never "Nade" again |
  | "Securite." | "Take your it." / "Secure it." | "Securite, secure it." / "Securite." — correct more often than not |
  | "Securite securite securite." | garbled, inconsistent | "Securite, Securite, Securite, Securite." both runs — exactly right |
  | "Pan-pan pan-pan pan-pan." | one run hallucinated ~100 repeats of "pan" | worst case 7 repeats of "pan", best case "Pan-pan, Pan-pan, Pan-pan, Pan-pan." — no more runaway loop |

  Real, measurable improvement — not perfect (isolated "Mayday" is still
  the weakest case), but the worst failure modes (complete word failure,
  runaway repetition) are gone. The service also showed queuing delays
  under back-to-back test load (4-core host, load average >4) that
  produced client-side timeouts even though the server-side transcription
  had actually succeeded — a test-harness timeout, not a recognition
  failure.

- **Installed on this host's live Signal K server from npm**
  (`signalk-m510e-connector@0.1.1`, published 2026-10-08, released as
  `v0.1.1` on GitHub). Signal K runs in a container with only `~/.signalk`
  bind-mounted, so a symlink to a checkout dangles from the container's
  point of view (this bit twice: `require()` fails silently while the
  plugin's routes still look mounted; check `communication.vhf.recording.status`
  and the data directory instead). A `file:` directory dependency in
  `~/.signalk/package.json` makes any `npm install` there recreate that
  symlink, so the entry is now the registry range `^0.1.1`.
  Plugin config sets `ipOverride` to `10.42.23.1` (the AP address; the
  default would bind eth0, where the radio is not) and `asrUri` to the
  local whisper (`tcp://127.0.0.1:10300`, host networking reaches it).
  **To update:** publish a new version, then fetch exactly that tarball
  (`npm pack signalk-m510e-connector@X.Y.Z`, check the shasum against
  `npm view ... dist.shasum`), replace `~/.signalk/node_modules/signalk-m510e-connector`
  with it, run `npm install --omit=dev` inside that directory in the
  container, and restart with `systemctl --user restart signalk-server.service`.
  (A plain `npm install signalk-m510e-connector@X.Y.Z` in the container
  failed for every package until `signalk-starlink-offshore` was removed
  on 2026-10-08: it depended on `npm`, which npm 12's default
  `allow-remote=none` refuses (EALLOWREMOTE). It works now, but this tree
  resolves from `package.json` ranges with no lockfile, so a real
  tree-wide install also upgrades unrelated packages; the manual tarball
  recipe above avoids that. npm 12 also skips dependency install scripts
  until approved, e.g. `@serialport/bindings-cpp`.) 9 synthetic test transmissions are
  in its log (every row's `notes` says `SYNTHETIC TEST DATA`).
- **Reverted on-the-fly RTP→WAV decoding after live playback testing
  found it silent.** The Play button showed a player bar but produced no
  sound — traced to `res.send(buffer)` (used by the old on-demand
  `/audio` decode) lacking HTTP Range support, which some `<audio>`
  implementations need. `finishTransmission` now writes both the raw RTP
  and a decoded WAV once, at capture time; `/audio` serves the stored WAV
  via `res.sendFile()` (Range-aware). The 9 already-seeded recordings
  (raw-only, from before this change) needed a one-time backfill script
  to decode and write their missing `.wav` files on the live server —
  new recordings don't need this. See CHANGELOG.md "Changed" for the full
  writeup.

- **"Securite" test audio was mispronounced — fixed.** Real on-air
  pronunciation is "say-curie-tay" (French-derived, per ITU-R
  radiotelephony convention), not how Piper's `en_US` voice reads the
  written word. `scripts/generate-test-audio.js`'s `securite-triple` case
  now has a `synthesisText` override carrying the phonetic spelling;
  `scripts/examples/securite-triple-*.wav` regenerated. The two live
  seeded rows using this phrase (#4, #6) were regenerated in place
  (same `audio_path`/id, new audio content, `duration_ms`/`byte_count`
  updated, `transcript` cleared) via a throwaway script, and now
  transcribe cleanly to "Securite" through the live plugin route. See
  CHANGELOG.md "Known limitations" for the accuracy data (comparable to
  before — this is about test-audio realism, not a recognition fix).

## Repo scaffold (v0.1.0)
`package.json`, `MIT-LICENSE`, `index.js` (plugin metadata/schema/placeholder
REST endpoints, radio connection not yet implemented at that point), framework-
less placeholder webapp, `node --test` tests, CI via SignalK's reusable
plugin-ci.yml, README with the phase plan, `CHANGELOG.md` (Keep-a-Changelog
format). Both scaffold-era open decisions are now resolved — see Scope
decisions above.
