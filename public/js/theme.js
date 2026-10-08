// Day/night mode, matching the other Signal K kiosk UIs: the page is dark in
// both modes, day is brighter to fight glare, night is dimmed to protect
// night vision. The mode follows the server's vessels.self.environment.mode
// unless the user picked one with the toggle (kept in localStorage).
var STORAGE_KEY = 'm510e-connector-mode';
var MODE_URL = '/signalk/v1/api/vessels/self/environment/mode';

function isMode(value) {
  return value === 'day' || value === 'night';
}

export function getStoredMode() {
  try {
    var stored = window.localStorage.getItem(STORAGE_KEY);
    return isMode(stored) ? stored : null;
  } catch (err) {
    return null; // localStorage can throw in some restricted/embedded browsers
  }
}

export function storeMode(mode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    // ignore: the choice just won't persist across reloads on this browser
  }
}

export function applyMode(mode) {
  if (!isMode(mode)) return;
  document.documentElement.setAttribute('data-mode', mode);
}

// One-shot REST read of the server's mode; null on any failure or any value
// other than day/night. Mode is chrome, not data, so this never throws.
export function fetchServerMode() {
  return fetch(MODE_URL)
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (body) {
      var value = body && typeof body === 'object' && 'value' in body ? body.value : body;
      return isMode(value) ? value : null;
    })
    .catch(function () { return null; });
}
