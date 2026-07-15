import { readAlertPrefs, writeAlertPref } from '../logic.js';

export function createAlertController(context) {
  const win = context.dependencies.window || globalThis.window || {};
  const nav = context.dependencies.navigator || globalThis.navigator || {};
  const storage = context.dependencies.storage || globalThis.localStorage;
  const getItem = key => storage?.getItem?.(key) ?? null;
  const setItem = (key, value) => storage?.setItem?.(key, value);
  let prefs = readAlertPrefs(getItem);
  let audioContext = null;

  function preferences() {
    return { ...prefs };
  }

  function setPreference(key, enabled) {
    if (!writeAlertPref(setItem, key, enabled)) return false;
    prefs = readAlertPrefs(getItem);
    return true;
  }

  function ensureAudio() {
    if (audioContext) return audioContext;
    const AudioContext = win.AudioContext || win.webkitAudioContext;
    if (!AudioContext) return null;
    try { audioContext = new AudioContext(); } catch { return null; }
    return audioContext;
  }

  function playTone(kind = 'success') {
    if (!prefs.sound) return;
    const audio = ensureAudio();
    if (!audio) return;
    try {
      if (audio.state === 'suspended') audio.resume?.();
      const now = audio.currentTime;
      const tones = kind === 'error' || kind === 'warning'
        ? [[440, 0], [330, 0.12]]
        : kind === 'need'
          ? [[660, 0], [660, 0.14]]
          : [[523.25, 0], [659.25, 0.11]];
      for (const [frequency, delay] of tones) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.14);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(now + delay);
        oscillator.stop(now + delay + 0.16);
      }
    } catch { /* Browsers may block audio until a user gesture. */ }
  }

  function haptic(type) {
    if (type !== 'tap' && !prefs.vibrate) return;
    if (!nav.vibrate) return;
    try {
      if (type === 'tap') nav.vibrate(12);
      else if (type === 'success' || type === 'need') nav.vibrate([15, 80, 15]);
      else if (type === 'error' || type === 'warning') nav.vibrate([30, 80, 30, 80, 30]);
    } catch { /* Vibration is optional. */ }
  }

  function cue(kind) {
    const resolved = kind === 'need' ? 'need' : kind;
    haptic(resolved);
    playTone(resolved);
  }

  function preview() {
    const previous = prefs;
    prefs = { ...prefs, sound: true, vibrate: true };
    cue('success');
    prefs = previous;
  }

  return { preferences, setPreference, ensureAudio, playTone, haptic, cue, preview };
}
