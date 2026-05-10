// ─── Global State ─────────────────────────────────────────────────────────────

const state = {
  mmr          : 0,
  rankImageUrl : null,
  lastMmrPlaylist : null,  // ← ajoute ça
  wins         : 0,
  losses       : 0,
  streak       : 0,
  mmrGained    : 0,
  overlayX     : null,
  overlayY     : null,
  overlayWidth : 300,
  overlayHeight: 110,
};

// ─── Windows ──────────────────────────────────────────────────────────────────

let mainWindow           = null;
let overlayWindow        = null;
let fullscreenCursorWindow = null;
let saveWindow           = null;
let gamepadWindow        = null;
let playerOverlayWindows = [];

// ─── RL Socket ────────────────────────────────────────────────────────────────

let client            = null;
let reconnectInterval = null;

// ─── RL Detection ─────────────────────────────────────────────────────────────

let rlWasActive    = false;
let rlCheckProcess = null;
let hideTimeout    = null;
let rlInstallPath  = null;

// ─── Player Data ──────────────────────────────────────────────────────────────

let playerID          = null;
let myTeamNum         = null;
let currentPlaylist   = null;
let lastPlaylist      = null;
let matchEnded        = false;
let initialMMRFetched = false;
let roundStarted      = false;
let gamePlayers       = [];
let playersLogged     = false;

// ─── Player Overlays ──────────────────────────────────────────────────────────

let playerOverlaysEnabled = false;

// ─── UI / Drag State ──────────────────────────────────────────────────────────

let isDraggable = false;

// ─── Scoreboard Key Binding ───────────────────────────────────────────────────

let scoreboardKey  = null;
let isBindingMode  = false;

// ─── Slot Positions ───────────────────────────────────────────────────────────

let slotPositions = {};

// ─── Live Score Tracking ──────────────────────────────────────────────────────

let previousOrder   = {};
let playerWon       = null;
let lastTimeSeconds = null;
let lastBOvertime   = null;

// ─── Custom RL Path ───────────────────────────────────────────────────────────

let customCookedPath = null;

// ─── Alt Key ──────────────────────────────────────────────────────────────────

let altKeyProcess = null;
let altIsHeld     = false;

// ─── RL Focus ─────────────────────────────────────────────────────────────────

let rlFocused = false;

// ─── Production Overlay ───────────────────────────────────────────────────────

let prodOverlayUserEnabled = false;

// ─── Recap Overlay ────────────────────────────────────────────────────────────

let recapOverlayWindow = null;
let recapHideTimer     = null;
let recapAutoEnabled   = false;
let recapPending       = false;

module.exports = {
  state,
  get mainWindow()            { return mainWindow; },
  set mainWindow(v)           { mainWindow = v; },
  get overlayWindow()         { return overlayWindow; },
  set overlayWindow(v)        { overlayWindow = v; },
  get fullscreenCursorWindow(){ return fullscreenCursorWindow; },
  set fullscreenCursorWindow(v){ fullscreenCursorWindow = v; },
  get saveWindow()            { return saveWindow; },
  set saveWindow(v)           { saveWindow = v; },
  get gamepadWindow()         { return gamepadWindow; },
  set gamepadWindow(v)        { gamepadWindow = v; },
  get playerOverlayWindows()  { return playerOverlayWindows; },
  set playerOverlayWindows(v) { playerOverlayWindows = v; },
  get client()                { return client; },
  set client(v)               { client = v; },
  get reconnectInterval()     { return reconnectInterval; },
  set reconnectInterval(v)    { reconnectInterval = v; },
  get rlWasActive()           { return rlWasActive; },
  set rlWasActive(v)          { rlWasActive = v; },
  get rlCheckProcess()        { return rlCheckProcess; },
  set rlCheckProcess(v)       { rlCheckProcess = v; },
  get hideTimeout()           { return hideTimeout; },
  set hideTimeout(v)          { hideTimeout = v; },
  get rlInstallPath()         { return rlInstallPath; },
  set rlInstallPath(v)        { rlInstallPath = v; },
  get playerID()              { return playerID; },
  set playerID(v)             { playerID = v; },
  get myTeamNum()             { return myTeamNum; },
  set myTeamNum(v)            { myTeamNum = v; },
  get currentPlaylist()       { return currentPlaylist; },
  set currentPlaylist(v)      { currentPlaylist = v; },
  get lastPlaylist()          { return lastPlaylist; },
  set lastPlaylist(v)         { lastPlaylist = v; },
  get matchEnded()            { return matchEnded; },
  set matchEnded(v)           { matchEnded = v; },
  get initialMMRFetched()     { return initialMMRFetched; },
  set initialMMRFetched(v)    { initialMMRFetched = v; },
  get roundStarted()          { return roundStarted; },
  set roundStarted(v)         { roundStarted = v; },
  get gamePlayers()           { return gamePlayers; },
  set gamePlayers(v)          { gamePlayers = v; },
  get playersLogged()         { return playersLogged; },
  set playersLogged(v)        { playersLogged = v; },
  get playerOverlaysEnabled() { return playerOverlaysEnabled; },
  set playerOverlaysEnabled(v){ playerOverlaysEnabled = v; },
  get isDraggable()           { return isDraggable; },
  set isDraggable(v)          { isDraggable = v; },
  get scoreboardKey()         { return scoreboardKey; },
  set scoreboardKey(v)        { scoreboardKey = v; },
  get isBindingMode()         { return isBindingMode; },
  set isBindingMode(v)        { isBindingMode = v; },
  get slotPositions()         { return slotPositions; },
  set slotPositions(v)        { slotPositions = v; },
  get previousOrder()         { return previousOrder; },
  set previousOrder(v)        { previousOrder = v; },
  get playerWon()             { return playerWon; },
  set playerWon(v)            { playerWon = v; },
  get lastTimeSeconds()       { return lastTimeSeconds; },
  set lastTimeSeconds(v)      { lastTimeSeconds = v; },
  get lastBOvertime()         { return lastBOvertime; },
  set lastBOvertime(v)        { lastBOvertime = v; },
  get customCookedPath()      { return customCookedPath; },
  set customCookedPath(v)     { customCookedPath = v; },
  get altKeyProcess()         { return altKeyProcess; },
  set altKeyProcess(v)        { altKeyProcess = v; },
  get altIsHeld()             { return altIsHeld; },
  set altIsHeld(v)            { altIsHeld = v; },
  get rlFocused()                  { return rlFocused; },
  set rlFocused(v)                 { rlFocused = v; },
  get prodOverlayUserEnabled()     { return prodOverlayUserEnabled; },
  set prodOverlayUserEnabled(v)    { prodOverlayUserEnabled = v; },
  get recapOverlayWindow()         { return recapOverlayWindow; },
  set recapOverlayWindow(v)        { recapOverlayWindow = v; },
  get recapHideTimer()             { return recapHideTimer; },
  set recapHideTimer(v)            { recapHideTimer = v; },
  get recapAutoEnabled()           { return recapAutoEnabled; },
  set recapAutoEnabled(v)          { recapAutoEnabled = v; },
  get recapPending()               { return recapPending; },
  set recapPending(v)              { recapPending = v; },
};
