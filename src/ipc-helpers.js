const S = require('./state');

function sendToMain(channel, data) {
  if (S.mainWindow && S.mainWindow.webContents) {
    S.mainWindow.webContents.send(channel, data);
  }
}

function sendToOverlay(channel, data) {
  if (S.overlayWindow && S.overlayWindow.webContents) {
    S.overlayWindow.webContents.send(channel, data);
  }
}

function broadcastState() {
  sendToMain('state-update', S.state);
  sendToOverlay('state-update', S.state);
}

module.exports = { sendToMain, sendToOverlay, broadcastState };
