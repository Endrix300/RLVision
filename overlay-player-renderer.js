const { ipcRenderer } = require('electron');

ipcRenderer.on('player-data', (_, data) => {
  const { name, mmr } = data;

  document.getElementById('playerName').textContent = name ?? '...';

  const mmrEl = document.getElementById('playerMMR');
  if (mmr !== null && mmr !== undefined) {
    mmrEl.textContent = mmr + ' MMR';
    mmrEl.classList.remove('loading');
    mmrEl.classList.add('pop');
    setTimeout(() => mmrEl.classList.remove('pop'), 400);
  } else {
    mmrEl.textContent = 'N/A';
    mmrEl.classList.remove('loading');
  }
});

ipcRenderer.on('drag-start', () => {
  document.getElementById('playerName').classList.add('visible');
});

ipcRenderer.on('drag-end', () => {
  document.getElementById('playerName').classList.remove('visible');
});