const { spawn } = require('child_process');

const S = require('./state');
const { sendToMain }    = require('./ipc-helpers');
const { saveScoreboardKey } = require('./persistence');
const { showPlayerOverlays, hidePlayerOverlays } = require('./overlays');

// ─── Labels ───────────────────────────────────────────────────────────────────

function getKeyLabel(code) {
  const map = {
    9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt',
    32: 'Space', 37: '←', 38: '↑', 39: '→', 40: '↓',
    112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4',
    116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  };
  if (map[code]) return map[code];
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  return `Key(${code})`;
}

function getGamepadButtonLabel(button) {
  const map = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y',
    4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
    8: 'Back', 9: 'Start', 10: 'LS', 11: 'RS',
    12: 'D-pad Up', 13: 'D-pad Down', 14: 'D-pad Left', 15: 'D-pad Right',
  };
  return map[button] ?? `Btn(${button})`;
}

// ─── Binding Mode ─────────────────────────────────────────────────────────────

function startBindingMode() {
  S.isBindingMode = true;

  // Keyboard
  const ps = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class KeyBinder {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    $ignored = @(1, 2, 4, 5, 6)
    Start-Sleep -Milliseconds 500
    $keys = 0..254
    while($true) {
      foreach ($k in $keys) {
        if ($ignored -contains $k) { continue }
        $s = [KeyBinder]::GetAsyncKeyState($k)
        if ($s -band 0x0001) {
          Write-Output "KEY:$k"
          exit
        }
      }
      Start-Sleep -Milliseconds 50
    }`,
  ]);

  ps.stdout.on('data', (data) => {
    if (!S.isBindingMode) { ps.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('KEY:')) {
      const code  = parseInt(line.replace('KEY:', ''));
      const label = getKeyLabel(code);
      S.scoreboardKey = { type: 'keyboard', code, label };
      S.isBindingMode = false;
      ps.kill();
      saveScoreboardKey();
      sendToMain('binding-captured', S.scoreboardKey);
    }
  });

  ps.stderr.on('data', (d) => console.log('PS bind err:', d.toString()));

  // Gamepad
  const psGamepad = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class XInputBinder {
        [DllImport("xinput1_4.dll")]
        public static extern int XInputGetState(int dwUserIndex, IntPtr pState);
        public static short GetButtons(IntPtr pState) {
          return Marshal.ReadInt16(pState, 4);
        }
        public static IntPtr AllocState() {
          return Marshal.AllocHGlobal(16);
        }
      }
"@
    $ptr = [XInputBinder]::AllocState()
    $prevButtons = 0
    Start-Sleep -Milliseconds 500
    while($true) {
      $result = [XInputBinder]::XInputGetState(0, $ptr)
      if ($result -eq 0) {
        $buttons = [XInputBinder]::GetButtons($ptr)
        $newPress = $buttons -band (-bnot $prevButtons)
        if ($newPress -ne 0) {
          Write-Output "BTN:$newPress"
          exit
        }
        $prevButtons = $buttons
      }
      Start-Sleep -Milliseconds 50
    }`,
  ]);

  psGamepad.stdout.on('data', (data) => {
    if (!S.isBindingMode) { psGamepad.kill(); return; }
    const line = data.toString().trim();
    if (line.startsWith('BTN:')) {
      const code  = parseInt(line.replace('BTN:', ''));
      const label = getGamepadButtonLabel(code);
      S.scoreboardKey = { type: 'gamepad', code, label };
      S.isBindingMode = false;
      psGamepad.kill();
      saveScoreboardKey();
      sendToMain('binding-captured', S.scoreboardKey);
    }
  });

  psGamepad.stderr.on('data', (d) => console.log('🎮 Gamepad bind err:', d.toString()));
}

// ─── Scoreboard Key Detection ─────────────────────────────────────────────────

function startScoreboardKeyDetection() {
  if (!S.scoreboardKey || S.scoreboardKey.type !== 'keyboard') return;

  const ps = spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class ScoreboardKey {
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
      }
"@
    $wasDown = $false
    while($true) {
      $state = [ScoreboardKey]::GetAsyncKeyState(${S.scoreboardKey.code})
      $isDown = ($state -band 0x8000) -ne 0
      if ($isDown -and -not $wasDown) {
        Write-Output 'SCOREBOARD_DOWN'
      } elseif (-not $isDown -and $wasDown) {
        Write-Output 'SCOREBOARD_UP'
      }
      $wasDown = $isDown
      Start-Sleep -Milliseconds 50
    }`,
  ]);

  ps.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').map(l => l.trim()).filter(Boolean);
    const last  = lines[lines.length - 1];
    if (last === 'SCOREBOARD_DOWN' && S.rlFocused) showPlayerOverlays();
    else if (last === 'SCOREBOARD_UP') hidePlayerOverlays();
  });

  ps.stderr.on('data', () => {});
  return ps;
}

module.exports = {
  getKeyLabel,
  getGamepadButtonLabel,
  startBindingMode,
  startScoreboardKeyDetection,
};
