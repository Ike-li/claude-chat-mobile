export function createSettingsController(context, {
  alerts,
  autoBind = true,
  haptic = () => {},
} = {}) {
  const dom = context.dom;

  function syncPreferences() {
    const preferences = alerts.preferences();
    if (dom.prefAlertSound) dom.prefAlertSound.checked = !!preferences.sound;
    if (dom.prefAlertVibrate) dom.prefAlertVibrate.checked = !!preferences.vibrate;
    if (dom.prefAlertForeground) dom.prefAlertForeground.checked = !!preferences.foregroundComplete;
  }

  function open() {
    haptic('tap');
    alerts.ensureAudio?.();
    syncPreferences();
    dom.settingsSheet?.classList.remove('translate-y-full');
    dom.settingsScrim?.classList.remove('hidden');
  }

  function close() {
    haptic('tap');
    dom.settingsSheet?.classList.add('translate-y-full');
    dom.settingsScrim?.classList.add('hidden');
  }

  function bindToggle(element, key) {
    if (!element) return;
    element.onchange = () => {
      alerts.setPreference(key, element.checked);
      if (key === 'sound' && element.checked) {
        alerts.ensureAudio?.();
        alerts.playTone?.('success');
      }
      if (key === 'vibrate' && element.checked) haptic('success');
    };
  }

  function bind() {
    if (dom.btnSettings) dom.btnSettings.onclick = open;
    if (dom.settingsClose) dom.settingsClose.onclick = close;
    if (dom.settingsScrim) dom.settingsScrim.onclick = close;
    bindToggle(dom.prefAlertSound, 'sound');
    bindToggle(dom.prefAlertVibrate, 'vibrate');
    bindToggle(dom.prefAlertForeground, 'foregroundComplete');
    if (dom.btnAlertPreview) {
      dom.btnAlertPreview.onclick = () => {
        alerts.ensureAudio?.();
        alerts.preview?.();
      };
    }
  }

  if (autoBind) bind();
  return { close, open, syncPreferences };
}
