const S = require('./state');
const { sendToOverlay } = require('./ipc-helpers');

function showOverlay() {
  console.log('👁️ overlayWindow exists:', !!S.overlayWindow);
  console.log('👁️ isVisible before:', S.overlayWindow?.isVisible());
  if (S.overlayWindow) {
    S.overlayWindow.showInactive();
    S.overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
    console.log('👁️ isVisible after:', S.overlayWindow.isVisible());
    sendToOverlay('state-update', S.state);
  }
}

function hideOverlay() {
  if (S.overlayWindow) S.overlayWindow.hide();
}

function showPlayerOverlays() {
  S.playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.showInactive();
  });
}

function hidePlayerOverlays() {
  S.playerOverlayWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.hide();
  });
}

module.exports = { showOverlay, hideOverlay, showPlayerOverlays, hidePlayerOverlays };