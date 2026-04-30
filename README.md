# 🎮 RLVision
> The first EAC-compatible Rocket League overlay — Real MMR tracking, Win/Loss/Streak, auto-show when RL is focused.

![License](https://img.shields.io/badge/license-MIT-blue)
![EAC](https://img.shields.io/badge/EAC-Compatible-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Version](https://img.shields.io/badge/version-2.0.0-purple)
![Free](https://img.shields.io/badge/price-Free-brightgreen)

## What's new in v2.0.0
- Real MMR tracking (fetched from rlstats.net after each match)
- Auto-detected playlist (1v1, 2v2, 3v3)
- Win / Loss counter with session stats
- Win and loss streak indicator
- Auto-show overlay when Rocket League is focused
- Auto-hide when you switch to another window
- Draggable overlay
- Toggle with Ctrl+Shift+H

## ⚙️ Required Configuration
Before launching RLVision, you need to enable the Stats API in Rocket League.

> 💡 RLVision uses the **official Rocket League Stats API** provided by Epic Games/Psyonix.
> You can read the official documentation here: https://www.rocketleague.com/en/developer/stats-api

1. Open this file with Notepad **as Administrator** :
   C:\Program Files\Epic Games\rocketleague\TAGame\Config\DefaultStatsAPI.ini

2. Make sure it contains :
```ini
[TAGame.MatchStatsExporter_TA]
Port=49123
PacketSendRate=60.0
```

3. Save the file and **restart Rocket League**

> ⚠️ This file must be edited **before** launching Rocket League. Changes won't apply while the game is running.

## 📥 Installation

### Just want to use RLVision? No commands needed!
👉 Download the installer directly here :
**https://github.com/Endrix300/RLVision/releases/tag/RLVision-installer**

1. Download `RLVision Setup 2.0.0.exe`
2. Run the installer
3. Launch RLVision from your desktop shortcut
4. Launch Rocket League — the overlay appears automatically

---

### Want to modify or customize the code?

**Option 1 — With Git** (recommended)

Install Git first : https://git-scm.com/download/win

```bash
git clone https://github.com/Endrix300/RLVision.git
cd RLVision
npm install
npm start
```

**Option 2 — Without Git**

1. Click the green **"Code"** button on the GitHub repo
2. Click **"Download ZIP"**
3. Extract the ZIP anywhere
4. Open a terminal in the folder and run :

```bash
npm install
npm start
```

Build :

```bash
npm run build
```

> 📁 After building, the installer will be generated in the `dist/` folder.
> Run it and RLVision will be installed and added to your desktop automatically.

## Security
> 💡 RLVision only reads data from Rocket League's **official local WebSocket** (localhost:49123).
> It does **not** inject code into the game, does **not** modify game files, and is fully **EAC compatible**.

✅ VirusTotal — RLVision.exe (0/70): https://virustotal.com/gui/file/fb18c27700eded64f7a1003b5bf9e3462c345227f716aaaa9efbbb2c67c7c3fc21/detection
✅ VirusTotal — Installer (0/70): https://www.virustotal.com/gui/file/caa68aacb140b9bccbd75e8b4a2a24894b358a9401c4d461dfd78034a4f8d13c

## Note
Windows may show a SmartScreen warning — click **More info** → **Run anyway**.
This is normal for unsigned independent software.

## 📸 Preview
<table border="0" cellspacing="0" cellpadding="0" width="100%">
  <tr>
    <td width="70%" align="center"><b>🎮 In-game Overlay</b></td>
    <td width="30%" align="center"><b>📊 Main App</b></td>
  </tr>
  <tr>
    <td width="70%"><img width="100%" alt="RLVision Overlay" src="https://github.com/user-attachments/assets/71720fb3-4cfd-4e9e-9e8f-5b77ef392df1" /></td>
    <td width="30%"><img width="100%" alt="RLVision App" src="https://github.com/user-attachments/assets/355c2790-8287-452c-8a36-b6eb28d42bdd" /></td>
  </tr>
</table>

