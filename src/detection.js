const { spawn } = require('child_process');

const S = require('./state');
const { sendToMain }        = require('./ipc-helpers');
const { showOverlay, hideOverlay, showPlayerOverlays, hidePlayerOverlays } = require('./overlays');

// ─── RL Focus Detection ───────────────────────────────────────────────────────

function startRLDetection() {
  const psProcess = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `while($true) {
      $rl = Get-Process -Name 'RocketLeague' -ErrorAction SilentlyContinue
      if ($rl) { Write-Output 'RL_RUNNING' } else { Write-Output 'RL_STOPPED' }
      Start-Sleep -Milliseconds 500
    }`
  ]);

  const psFocus = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Focus { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId); }'
    while($true) {
      $rl = Get-Process -Name 'RocketLeague' -ErrorAction SilentlyContinue
      if ($rl) {
        $fg = [Win32Focus]::GetForegroundWindow()
        $fgPid = 0
        [Win32Focus]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
        $rlPid = if ($rl -is [array]) { $rl[0].Id } else { $rl.Id }
        if ($fgPid -eq $rlPid) { Write-Output 'RL_FOCUSED' }
        else { Write-Output 'RL_UNFOCUSED' }
      } else { Write-Output 'RL_UNFOCUSED' }
      Start-Sleep -Milliseconds 500
    }`
  ]);

  let rlRunning = false;
  let rlFocused = false;

  psProcess.stdout.on('data', (data) => {
    console.log('📡 psProcess:', data.toString().trim());
    const line = data.toString().trim();
    rlRunning = line.includes('RL_RUNNING');
    updateOverlayVisibility();
  });

  psFocus.stdout.on('data', (data) => {
    console.log('📡 psFocus:', data.toString().trim());
    const line = data.toString().trim();
    rlFocused = line.includes('RL_FOCUSED');
    S.rlFocused = rlFocused;
    updateOverlayVisibility();
  });

  psProcess.stderr.on('data', (d) => console.log('❌ psProcess error:', d.toString()));
  psFocus.stderr.on('data', (d) => console.log('❌ psFocus error:', d.toString()));

  function updateOverlayVisibility() {
    if (S.altIsHeld) return;
    const shouldShow = rlRunning && rlFocused;
    if (shouldShow) {
      if (S.hideTimeout) { clearTimeout(S.hideTimeout); S.hideTimeout = null; }
      if (!S.rlWasActive) {
        S.rlWasActive = true;
        showOverlay();
      }
      if (S.prodOverlayUserEnabled && S.prodOverlayWindow && !S.prodOverlayWindow.isDestroyed())
        S.prodOverlayWindow.showInactive();
      if (S.recapPending && S.recapOverlayWindow && !S.recapOverlayWindow.isDestroyed()) {
        S.recapPending = false;
        S.recapOverlayWindow.showInactive();
        S.recapOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
      }
    } else if (S.rlWasActive) {
      if (!S.hideTimeout) {
        S.hideTimeout = setTimeout(() => {
          if (S.altIsHeld) { S.hideTimeout = null; return; }
          S.rlWasActive = false;
          hideOverlay();
          hidePlayerOverlays();
          if (S.prodOverlayWindow && !S.prodOverlayWindow.isDestroyed())
            S.prodOverlayWindow.hide();
          if (S.recapOverlayWindow && !S.recapOverlayWindow.isDestroyed())
            S.recapOverlayWindow.hide();
          S.hideTimeout = null;
        }, 1000);
      }
    }
  }

  S.rlCheckProcess = psProcess;
}

// ─── Alt Key Detection ────────────────────────────────────────────────────────

function startAltKeyDetection() {
  S.altKeyProcess = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class KeyState {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    while($true) {
      $alt = [KeyState]::GetAsyncKeyState(0x12)
      if ($alt -band 0x8000) {
        Write-Output 'ALT_DOWN'
      } else {
        Write-Output 'ALT_UP'
      }
      Start-Sleep -Milliseconds 100
    }`,
  ]);

  S.altKeyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last  = lines[lines.length - 1];

    if (last === 'ALT_DOWN' && !S.altIsHeld) {
      S.altIsHeld   = true;
      S.isDraggable = true;
      showPlayerOverlays();

      if (S.saveWindow && !S.saveWindow.isDestroyed()) {
        S.saveWindow.showInactive();
        S.saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }
      if (S.fullscreenCursorWindow && !S.fullscreenCursorWindow.isDestroyed()) {
        S.fullscreenCursorWindow.showInactive();
        S.fullscreenCursorWindow.setAlwaysOnTop(true, 'normal');
        S.fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
      }
      if (S.overlayWindow && !S.overlayWindow.isDestroyed()) {
        S.overlayWindow.setIgnoreMouseEvents(false);
        S.overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }
      S.playerOverlayWindows.forEach(w => {
        if (w && !w.isDestroyed()) {
          w.setIgnoreMouseEvents(false);
          w.setAlwaysOnTop(true, 'pop-up-menu');
        }
      });
      if (S.saveWindow && !S.saveWindow.isDestroyed()) {
        S.saveWindow.setIgnoreMouseEvents(false);
        S.saveWindow.setAlwaysOnTop(true, 'pop-up-menu');
      }

    } else if (last === 'ALT_UP' && S.altIsHeld) {
      S.altIsHeld   = false;
      S.isDraggable = false;
      hidePlayerOverlays();

      if (S.saveWindow && !S.saveWindow.isDestroyed()) S.saveWindow.hide();
      if (S.fullscreenCursorWindow && !S.fullscreenCursorWindow.isDestroyed()) {
        S.fullscreenCursorWindow.setIgnoreMouseEvents(true, { forward: true });
        S.fullscreenCursorWindow.hide();
      }
      if (S.overlayWindow && !S.overlayWindow.isDestroyed())
        S.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      S.playerOverlayWindows.forEach(w => {
        if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
      });
    }
  });

  S.altKeyProcess.stderr.on('data', () => {});
}

module.exports = { startRLDetection, startAltKeyDetection };
