# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- `retentionMaxSizeMB` config option (size-based retention, independent
  of the existing `retentionDays`).
- Real backend implementation, ahead of Phase 0 hardware validation:
  - `lib/protocol.js` — pure, unit-tested packet encode/decode helpers
    (discovery, sign-in, keepalive, channel-status parsing).
  - `lib/radioClient.js` — `RadioClient` EventEmitter wrapping the UDP
    session (discovery/sign-in/keepalive/busy-flag tracking/RX voice
    capture). No file I/O — consumers persist via emitted events.
  - `lib/db.js` — `node:sqlite`-backed transmissions table and
    query/insert/delete helpers.
  - `lib/retention.js` — age- and size-based pruning, oldest-first,
    removes both the DB row and the audio file.
  - `index.js` now wires all of the above together and serves real data
    from `/status`, `/transmissions`, `/transmissions/:id`,
    `/transmissions/:id/audio`.
- Test coverage: `test/protocol.test.js`, `test/db.test.js`,
  `test/retention.test.js`, updated `test/plugin.test.js` exercising
  real start/stop/router wiring against a temp data dir.
- `tools/capture-spike/capture.sanitized.pcap` — a real ~10s Phase 0
  sample capture (GPS fix and MAC addresses pseudonymized) of an M510E
  WiFi session.
- `test/pcap-replay.test.js`, `test/helpers/pcap.js`,
  `test/radioClient.test.js` — replay real captured bytes (and synthetic
  edge cases) through `lib/protocol.js`/`lib/radioClient.js` without
  needing live hardware. See Phase 0 findings below.
- `lib/rtpAudio.js` — frames captured RTP packets for on-disk storage
  (length-prefixed, so packet boundaries survive being written to a
  single file) and decodes that framed form to a playable WAV
  (RTP/PCMU → mu-law → 16-bit PCM → RIFF/WAVE) on demand. Recordings on
  disk stay raw/undecoded for forensic purposes; `GET
  /transmissions/:id/audio` decodes per request, not at capture time.
  `test/rtpAudio.test.js` and an end-to-end decode of the real sample
  capture in `test/pcap-replay.test.js` cover it.
- Phase 2 webapp (`public/`): buildless Preact+htm, vendored dependencies
  (`public/vendor/preact-htm-standalone.js`), no CDN — matches
  signalk-stowage-mgmt's convention, including its red-shifted dark/night
  theme. Sortable transmission table (start time, channel, duration,
  direction, position, size), filter by channel number and date range
  (server-side, via the existing `/transmissions` query params), inline
  playback through a bottom player bar (`<audio>` pointed at
  `/transmissions/:id/audio`), WAV download per row, a live
  radio-connection status pill polling `/status`. Verified interactively
  (sort toggling, filtering, play/stop, theme switch, no console errors)
  against a mock API server using headless Chromium + puppeteer-core,
  since this sandbox can't run the real plugin (`node:sqlite`/Node 20) or
  reach real hardware. Not yet checked against a real, populated database
  or a live radio.
- `communication.vhf.recording.status` SignalK path: emits `'recording'`
  via `app.handleMessage` on `tx-start`, `'idle'` on `tx-end` and on
  plugin start/stop — a custom, non-spec path, since nothing in the core
  SignalK schema covers this. Closes the last open Phase 2 item.
  Verified in `test/plugin.test.js` (initial `'idle'` emission on start)
  against a real `node:sqlite`-free run using a minimal in-process
  `DatabaseSync` shim, since this sandbox's Node 20 can't load
  `lib/db.js` otherwise.
- Optional speech-to-text: `POST /transmissions/:id/transcribe` sends a
  recording's decoded PCM to a Wyoming ASR service (e.g.
  [signalk-whisper](https://github.com/hoeken/signalk-whisper) reached
  through an optional [signalk-wyoming](https://github.com/hoeken/signalk-wyoming)
  installation) and stores the result via `db.setTranscript` (new
  `transcript` column). New `asrUri`/`asrLanguage` config options,
  disabled (`501`) unless `asrUri` is set — nothing else in this plugin
  depends on it.
  - `lib/wyomingProtocol.js` — minimal, self-contained Wyoming wire
    framing (encode/decode). Not a dependency on the unpublished
    `signalk-wyoming/protocol` package; its own DEVELOPERS.md says
    sibling plugins embed a tiny reimplementation for production instead
    of depending on it — same choice here.
  - `lib/wyomingClient.js` — `transcribeAudio()` talks directly to the
    ASR service's raw Wyoming TCP port (transcribe → audio-start →
    audio-chunk(s) → audio-stop → transcript). signalk-wyoming's own REST
    API (`POST /plugins/signalk-wyoming/api/transcribe`) only records
    *live* from a satellite mic; there's no documented way to hand it
    audio that's already been recorded, hence talking to the ASR service
    directly instead of the orchestrator.
  - Webapp: a per-row Transcribe button, showing the transcript once
    done, a re-transcribe icon after that, or an error indicator on
    failure.
  - Test coverage: `test/wyomingProtocol.test.js` (framing round-trips,
    split reads, malformed input), `test/wyomingClient.test.js` (against
    a real mock Wyoming TCP server — success, ignored intermediate
    events, service errors, connection-refused, timeout), a decode-path
    parity check against the real sample capture in
    `test/pcap-replay.test.js`, and the `501`-when-unconfigured route
    guard in `test/plugin.test.js`.
  - Since verified end to end against a real Piper + whisper install on
    this host (see "Known limitations" below) — Piper-synthesized test
    phrases resampled to 8kHz, mu-law encoded, and framed as fake RTP
    packets matching the real M510E's wire format, run through the exact
    frame/unframe/decode path production code uses, then transcribed by
    the real whisper container.

### Known limitations

- **Standard VHF prowords (Mayday, Pan-pan, Securite) transcribe poorly on
  a whisper `tiny-int8` model whose `--initial-prompt` doesn't include
  them.** General maritime traffic phraseology transcribed at ~90%+ word
  accuracy in testing; "Mayday." alone came back as "Nade." every time,
  "Securite." as "Take your it."/"Secure it.", and a tripled "Pan-pan"
  triggered a Whisper repetition-loop bug (~100 repeats of "pan" in one
  run). Root cause: `--initial-prompt` is a server-side startup flag
  (confirmed in `wyoming-faster-whisper`'s `dispatch_handler.py` — only
  `language` from our `transcribe` event is honored, not `context`/`name`),
  and a shared instance's prompt is commonly tuned for an unrelated
  voice-command use case with no VHF vocabulary in it at all. See
  README.md's "Known limitation" section for the recommended fix (extend
  the shared instance's initial prompt) and a copy-pasteable snippet.
  Not fixable from this plugin's own code — but the fix was applied to
  this host's shared whisper instance and confirmed to measurably help:
  "Securite securite securite" went from consistently garbled to exactly
  correct on both re-test runs, and the tripled "Pan-pan" repetition-loop
  bug (previously ~100 repeats of "pan") dropped to at most 7. Isolated
  "Mayday" is still the weakest case (correct roughly half the time
  post-fix, vs. never before) — a bigger model would likely help further
  but wasn't tested.
- **Our own "Securite" test audio was mispronounced.** "Securite" is
  French in origin; the real on-air pronunciation ("say-curie-tay", per
  ITU-R radiotelephony convention) doesn't match how Piper's `en_US`
  voice reads the written word. `scripts/generate-test-audio.js` now has
  a `synthesisText` field on the `securite-triple` case carrying the
  phonetic spelling actually sent to Piper, while `text` stays the
  canonical spelling for labels/notes/logging.
  `scripts/examples/securite-triple-*.wav` regenerated accordingly.
  Recognition accuracy is comparable to before (not a fix for that) — the
  point is realism: the test audio now says what a real VHF radio would
  actually say, not an English misreading of the written proword.

### Fixed

- `RadioClient` now sends the read-only post-login requests the radio needs
  before it pushes channel status and voice: channel table part 1 on the
  first radio heartbeat, part 2 after 2s, then ask-channel and an empty
  status query on the control socket after 4s (`tablePart2Ms`,
  `askStatusMs`). `lib/protocol.js` gains `buildChannelTableRequest`,
  `buildAskChannelPacket` and `buildQueryStatusPacket`, checked byte for
  byte against htool's current plugin; `buildChannelQueryPacket` was the
  same bytes as the ask-channel frame and was never called. There are
  deliberately no builders for anything that changes radio state (a test
  enforces this).
- `RadioClient` keepalives now go back to the address and port the radio's
  heartbeats come from (50002), not the sign-in port 50000. Seen live: the
  old target drew identity broadcasts to port 60000 instead.
- Tested against a real IC-M510E (2026-10-08). Discovery, sign-in,
  heartbeats and the channel table request work. With someone keying up on
  a handheld on channel 27, channel status (cmd 0x201) arrived unprompted
  on the control socket at squelch open and close, `parseChannelStatus`
  read it correctly (busy flag, channel number, squelch), `tx-start` and
  `tx-end` fired for both transmissions (about 0.9s and 1.4s), and 47 RTP
  voice packets (332 bytes, the same shape as the 2023 capture) arrived on
  port 50001. The ask-channel and status-query frames never got a direct
  reply; status is pushed on change, so they may not be needed. Not yet
  checked: whether every voice packet of a transmission is received (47
  seen against roughly 57 expected from the busy durations), a recording
  played back from a live capture, and multi-client coexistence with the
  phone app. Discovery replies are slow and uneven (3s to 55s), and a
  reply that arrives very late is not followed by a sign-in response, so
  the client probably needs a sign-in retry.
- `RadioClient` busy-flag tracking now keys off `channelNr` and debounces
  a not-busy reading on the active channel (`busyDebounceMs`, default
  200ms), instead of flipping on any status packet. Fixes transmission
  fragmentation on a dual-watch/scanning radio.
- `parseChannelStatus` now checks the response-type byte explicitly
  (`CHANNEL_STATUS_RESPONSE_TYPE`) instead of only inferring the packet
  shape from length, correctly distinguishing the real 40-byte
  channel-status response from the 28-byte ack/heartbeat response that
  shares the same port.

### Changed

- Minimum Node version raised to 22.5.0 (first version with `node:sqlite`).
- Package/plugin renamed from `signalk-icom-radio-log` to
  `signalk-m510e-connector` (`package.json` name, `signalk.displayName`,
  `index.js` plugin `id`/`name`). The GitHub repo was also renamed to
  match: BoatHacks/signalk-icom-radio-log → BoatHacks/signalk-m510e-connector.
- **Reverted on-the-fly RTP→WAV decoding.** `GET /transmissions/:id/audio`
  used to decode the stored raw RTP to WAV on every request
  (`res.send(buffer)`); found not to play reliably in the browser after
  live testing (`res.send(buffer)` has no HTTP Range support, which some
  `<audio>` implementations need to play at all). Now `finishTransmission`
  writes both the raw RTP file and a decoded WAV once, at capture time,
  and `/audio` serves the stored WAV via `res.sendFile()` (Range-aware).
  `lib/rtpAudio.js` gained `rawPathToWavPath()` so `index.js` and
  `lib/retention.js` can find/delete the paired file from either path
  without a second DB column. Retention now deletes both files together;
  `byte_count` reflects raw+WAV combined. Existing recordings from before
  this change (raw-only) needed a one-time backfill to decode and write
  their missing `.wav` file.

### Decided

- Standalone — no dependency on `signalk-icom-m510e-plugin`.
- Retention configurable by age and/or total log size, whichever limit
  hits first prunes oldest-first.
- Final project name: `signalk-m510e-connector`.
- TX-less logging is acceptable for v1 — outgoing (TX/PTT) and hailer/PA
  audio moved to v2.

### Phase 0 findings

- RX codec identified from the sample capture: plain RTP, payload type 0
  (PCMU/G.711 µ-law), 320-byte payloads at ~40ms intervals (320 samples
  at 8kHz) — no proprietary Icom vocoder. RTCP (sender reports + SDES)
  also standard.
- TX and hailer/PA codecs still unidentified — the sample capture is only
  ~10s of RX audio and caught neither. No longer a v1 blocker now that
  outgoing audio is v2 scope; still worth resolving on a future,
  longer capture-spike run.
- Busy-flag replay finding, **fixed**: replaying the sample capture's
  channel-status packets through `lib/radioClient.js` used to fragment
  one continuous ~7.4s RX transmission into 3 separate `tx-start`/`tx-end`
  cycles — the radio dual-watches/scans channel 84 and channel 93, and
  each status response for the idle channel (93) read as squelch-closed
  even though the busy channel (84) was still transmitting; a genuine
  ~50ms squelch blip on the active channel itself also briefly toggled
  not-busy between syllables of real speech. `RadioClient` now keys
  busy-tracking off `channelNr` (ignoring status for a channel other than
  the one currently open) and debounces a not-busy reading on the active
  channel for `busyDebounceMs` (default 200ms) before treating it as a
  real `tx-end`. Replaying the same capture now yields a single
  `tx-start` with no fragmentation (see `test/pcap-replay.test.js`,
  `test/radioClient.test.js`).
- `parseChannelStatus` undersized-packet finding, **fixed**: the real
  28-byte packets on `CHANNEL_CMD_PORT` (50003) aren't truncated status
  packets — they're a distinct ack/heartbeat response (response-type
  byte `[17] === 0x01`, no channel data), interleaved with the real
  40-byte status responses (`[17] === 0x02`). `parseChannelStatus` now
  checks that type byte explicitly instead of only inferring the packet
  shape from length (see `lib/protocol.js`, `CHANNEL_STATUS_RESPONSE_TYPE`).

## [0.1.0] - 2026-07-20

### Added

- Initial plugin scaffold: SignalK plugin metadata, config schema
  (`ipOverride`, `retentionDays`), and placeholder REST endpoints
  (`GET /status`, `GET /transmissions`).
- Placeholder webapp page.
- CI via SignalK's reusable `plugin-ci.yml` workflow.
- `node --test` smoke tests covering plugin metadata, lifecycle, and
  the placeholder routes.
- README documenting the phased project plan (Phase 0 research spike
  through Phase 4 retention/polish).

Radio-joining logic (discovery, sign-in, transmission capture) is not
implemented yet — see README.md.
