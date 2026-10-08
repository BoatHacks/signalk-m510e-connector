export function formatTimestamp(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  var totalSeconds = Math.round(ms / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

// [latitude, longitude] as separate strings (the table shows them on two
// lines), or null when the position is unknown.
export function formatPositionLines(lat, lon) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
  return [lat.toFixed(4), lon.toFixed(4)];
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Local "yyyy-mm-dd" (as produced by <input type="date">) -> start/end of
// day in epoch ms, for the from/to query params.
export function dateInputToStartOfDayMs(dateStr) {
  if (!dateStr) return undefined;
  var d = new Date(dateStr + 'T00:00:00');
  return d.getTime();
}

export function dateInputToEndOfDayMs(dateStr) {
  if (!dateStr) return undefined;
  var d = new Date(dateStr + 'T23:59:59.999');
  return d.getTime();
}
