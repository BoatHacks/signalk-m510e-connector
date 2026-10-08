import { html, render, useState, useEffect, useCallback } from '../vendor/preact-htm-standalone.js';
import { api } from './api.js';
import { getStoredMode, storeMode, applyMode, fetchServerMode } from './theme.js';
import { formatTimestamp, formatDuration, formatPositionLines, formatBytes, dateInputToStartOfDayMs, dateInputToEndOfDayMs } from './helpers.js';

var STATUS_POLL_MS = 5000;
var MODE_POLL_MS = 30000;
var LIST_POLL_MS = 10000;

var COLUMNS = [
  { key: 'start_ts', label: 'Start' },
  { key: 'channel_nr', label: 'Channel' },
  { key: 'duration_ms', label: 'Duration' },
  { key: 'direction', label: 'Direction' },
  { key: 'lat', label: 'Position' },
  { key: 'file_bytes', label: 'Size' }
];

function compareValues(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'string') return a.localeCompare(b);
  return a - b;
}

function sortTransmissions(transmissions, sortKey, sortDir) {
  var sorted = transmissions.slice().sort(function (a, b) {
    var cmp = compareValues(a[sortKey], b[sortKey]);
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

function LinkStatus(props) {
  var status = props.status;
  if (!status) return html`<span class="link unknown"><span class="dot"></span>Loading</span>`;
  if (!status.connected) return html`<span class="link lost"><span class="dot"></span>Radio not connected</span>`;
  var label = status.recording ? 'Recording' : 'Listening';
  return html`
    <span class=${'link' + (status.recording ? ' recording' : '')} title=${status.ip + ':' + status.port}>
      <span class="dot"></span>${label} · <span class="mono">${status.ip}</span>
    </span>
  `;
}

function Clock() {
  var nowState = useState(new Date());
  var now = nowState[0], setNow = nowState[1];
  useEffect(function () {
    var timer = setInterval(function () { setNow(new Date()); }, 1000);
    return function () { clearInterval(timer); };
  }, []);
  return html`<span class="clock mono">${now.toLocaleTimeString([], { hour12: false })}</span>`;
}

function ModeToggle(props) {
  return html`
    <button class="mode-toggle" onClick=${props.onToggle} title="Switch between day and night colors">
      ${props.mode === 'night' ? 'Night' : 'Day'}
    </button>
  `;
}

function SortableHeader(props) {
  var active = props.sortKey === props.column.key;
  return html`
    <th onClick=${function () { props.onSort(props.column.key); }}>
      ${props.column.label}
      ${active ? html`<span class="sort-arrow">${props.sortDir === 'asc' ? '▲' : '▼'}</span>` : null}
    </th>
  `;
}

function TranscribeCell(props) {
  var tx = props.tx;
  if (props.transcribing) return html`<span class="transcript-pending">Transcribing…</span>`;
  if (tx.transcript) {
    return html`<button class="transcribe-btn" onClick=${function () { props.onTranscribe(tx); }} title="Re-transcribe">↻</button>`;
  }
  return html`
    <button class="transcribe-btn" onClick=${function () { props.onTranscribe(tx); }}>Transcribe</button>
    ${props.error ? html`<span class="transcript-error" title=${props.error}>⚠</span>` : null}
  `;
}

function TranscriptCell(props) {
  var tx = props.tx;
  if (!tx.transcript) return html`—`;
  return html`<span class="transcript-text">${tx.transcript}</span>`;
}

function TransmissionRow(props) {
  var tx = props.tx;
  var isPlaying = props.nowPlayingId === tx.id;
  return html`
    <tr class=${isPlaying ? 'now-playing' : ''}>
      <td class="num">${formatTimestamp(tx.start_ts)}</td>
      <td class="num channel">${tx.channel_nr === null || tx.channel_nr === undefined ? '—' : tx.channel_nr}</td>
      <td class="num">${formatDuration(tx.duration_ms)}</td>
      <td>${tx.direction}</td>
      <td class="num position">${(function () {
        var lines = formatPositionLines(tx.lat, tx.lon);
        return lines ? html`<span>${lines[0]}</span><span>${lines[1]}</span>` : '—';
      })()}</td>
      <td class="num">${formatBytes(tx.file_bytes)}</td>
      <td>
        <button class="play-btn" onClick=${function () { props.onPlay(tx); }}>
          ${isPlaying ? '■' : '▶'}
        </button>
      </td>
      <td>
        <a class="download-btn" href=${api.audioUrl(tx.id)} download=${'transmission-' + tx.id + '.wav'} title="Download">⬇</a>
      </td>
      <td>
        <${TranscribeCell} tx=${tx} transcribing=${props.transcribing} error=${props.transcribeError} onTranscribe=${props.onTranscribe} />
      </td>
      <td class="transcript-cell">
        <${TranscriptCell} tx=${tx} />
      </td>
    </tr>
  `;
}

function PlayerBar(props) {
  if (!props.nowPlaying) return null;
  var tx = props.nowPlaying;
  var label = 'Ch ' + (tx.channel_nr === null || tx.channel_nr === undefined ? '—' : tx.channel_nr) +
    ' — ' + formatTimestamp(tx.start_ts);
  return html`
    <div class="player-bar">
      <span class="player-label">${label}</span>
      <audio controls autoplay src=${api.audioUrl(tx.id)} onEnded=${props.onEnded}></audio>
      <button class="player-close" onClick=${props.onClose} title="Close player">✕</button>
    </div>
  `;
}

function App() {
  // Follows the server's environment.mode unless the toggle was used.
  var modeState = useState(getStoredMode() || 'day');
  var mode = modeState[0], setMode = modeState[1];

  var statusState = useState(null);
  var status = statusState[0], setStatus = statusState[1];

  var transmissionsState = useState([]);
  var transmissions = transmissionsState[0], setTransmissions = transmissionsState[1];

  var loadedState = useState(false);
  var loaded = loadedState[0], setLoaded = loadedState[1];

  var errorState = useState(null);
  var error = errorState[0], setError = errorState[1];

  var sortState = useState({ key: 'start_ts', dir: 'desc' });
  var sort = sortState[0], setSort = sortState[1];

  var channelFilterState = useState('');
  var channelFilter = channelFilterState[0], setChannelFilter = channelFilterState[1];
  var fromFilterState = useState('');
  var fromFilter = fromFilterState[0], setFromFilter = fromFilterState[1];
  var toFilterState = useState('');
  var toFilter = toFilterState[0], setToFilter = toFilterState[1];

  var nowPlayingState = useState(null);
  var nowPlaying = nowPlayingState[0], setNowPlaying = nowPlayingState[1];

  var transcribingIdsState = useState(function () { return new Set(); });
  var transcribingIds = transcribingIdsState[0], setTranscribingIds = transcribingIdsState[1];
  var transcribeErrorsState = useState({});
  var transcribeErrors = transcribeErrorsState[0], setTranscribeErrors = transcribeErrorsState[1];

  useEffect(function () { applyMode(mode); }, [mode]);

  useEffect(function () {
    function follow() {
      if (getStoredMode()) return;
      fetchServerMode().then(function (serverMode) { if (serverMode && !getStoredMode()) setMode(serverMode); });
    }
    follow();
    var timer = setInterval(follow, MODE_POLL_MS);
    return function () { clearInterval(timer); };
  }, []);

  useEffect(function () {
    function poll() {
      api.getStatus().then(setStatus).catch(function () { /* leave last-known status */ });
    }
    poll();
    var timer = setInterval(poll, STATUS_POLL_MS);
    return function () { clearInterval(timer); };
  }, []);

  var fetchTransmissions = useCallback(function () {
    var query = { limit: 500 };
    if (channelFilter !== '') query.channelNr = Number(channelFilter);
    var fromMs = dateInputToStartOfDayMs(fromFilter);
    if (fromMs !== undefined) query.from = fromMs;
    var toMs = dateInputToEndOfDayMs(toFilter);
    if (toMs !== undefined) query.to = toMs;
    return api.listTransmissions(query)
      .then(function (list) {
        setTransmissions(list);
        setLoaded(true);
        setError(null);
      })
      .catch(function (err) { setError(err.message); });
  }, [channelFilter, fromFilter, toFilter]);

  useEffect(function () {
    fetchTransmissions();
    var timer = setInterval(fetchTransmissions, LIST_POLL_MS);
    return function () { clearInterval(timer); };
  }, [fetchTransmissions]);

  var handleSort = function (key) {
    setSort(function (prev) {
      if (prev.key === key) return { key: key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key: key, dir: 'desc' };
    });
  };

  var handlePlay = function (tx) {
    setNowPlaying(function (prev) { return prev && prev.id === tx.id ? null : tx; });
  };

  var handleTranscribe = function (tx) {
    if (transcribingIds.has(tx.id)) return;
    setTranscribingIds(function (prev) { return new Set(prev).add(tx.id); });
    setTranscribeErrors(function (prev) {
      var next = Object.assign({}, prev);
      delete next[tx.id];
      return next;
    });
    api.transcribe(tx.id)
      .then(function (result) {
        setTranscriptions(tx.id, result.transcript);
      })
      .catch(function (err) {
        setTranscribeErrors(function (prev) {
          var next = Object.assign({}, prev);
          next[tx.id] = err.message;
          return next;
        });
      })
      .then(function () {
        setTranscribingIds(function (prev) {
          var next = new Set(prev);
          next.delete(tx.id);
          return next;
        });
      });
  };

  function setTranscriptions(id, transcript) {
    setTransmissions(function (prev) {
      return prev.map(function (t) { return t.id === id ? Object.assign({}, t, { transcript: transcript }) : t; });
    });
  }

  var sorted = sortTransmissions(transmissions, sort.key, sort.dir);

  return html`
    <div class="app">
      <header class="chrome">
        <div class="chrome-left">
          <h1>M510E Connector</h1>
          <${LinkStatus} status=${status} />
        </div>
        <div class="chrome-right">
          <${ModeToggle} mode=${mode} onToggle=${function () {
            var next = mode === 'night' ? 'day' : 'night';
            storeMode(next);
            setMode(next);
          }} />
          <${Clock} />
        </div>
      </header>
      <main>

      <div class="filters">
        <label>
          Channel
          <input type="number" value=${channelFilter}
            onInput=${function (e) { setChannelFilter(e.target.value); }} placeholder="all" />
        </label>
        <label>
          From
          <input type="date" value=${fromFilter} onInput=${function (e) { setFromFilter(e.target.value); }} />
        </label>
        <label>
          To
          <input type="date" value=${toFilter} onInput=${function (e) { setToFilter(e.target.value); }} />
        </label>
        <button onClick=${fetchTransmissions}>Refresh</button>
      </div>

      ${error ? html`<div class="error-banner">${error}</div>` : null}

      <div class="panel table-scroll">
        <table class="tx-table">
          <thead>
            <tr>
              ${COLUMNS.map(function (col) {
                return html`<${SortableHeader} column=${col} sortKey=${sort.key} sortDir=${sort.dir} onSort=${handleSort} />`;
              })}
              <th>Play</th>
              <th>Download</th>
              <th>Transcribe</th>
              <th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            ${!loaded
              ? html`<tr><td colSpan="10" class="empty-row">Loading…</td></tr>`
              : sorted.length === 0
                ? html`<tr><td colSpan="10" class="empty-row">No recordings yet.</td></tr>`
                : sorted.map(function (tx) {
                    return html`<${TransmissionRow} tx=${tx} nowPlayingId=${nowPlaying ? nowPlaying.id : null} onPlay=${handlePlay}
                      transcribing=${transcribingIds.has(tx.id)} transcribeError=${transcribeErrors[tx.id]} onTranscribe=${handleTranscribe} />`;
                  })}
          </tbody>
        </table>
      </div>

      </main>

      <${PlayerBar} nowPlaying=${nowPlaying} onClose=${function () { setNowPlaying(null); }} onEnded=${function () { setNowPlaying(null); }} />
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
