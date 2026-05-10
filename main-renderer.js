const { ipcRenderer } = require('electron');

// ── Profile Management ────────────────────────────────────────────────────────

let profiles = {};

 function profileExists(name) {
   return Object.prototype.hasOwnProperty.call(profiles, name);
 }

function loadProfiles() {
  try {
    const data = localStorage.getItem('rlvision_profiles');
    const parsed = data ? JSON.parse(data) : {};
    profiles = Object.assign(Object.create(null), parsed);
  } catch (e) {
    profiles = Object.create(null);
  }
}

function saveProfiles() {
  localStorage.setItem('rlvision_profiles', JSON.stringify(profiles));
}

function createProfile() {
  console.log('createProfile called');
  const input = document.getElementById('newProfileName');
  console.log('input:', input);
  const name = String(input?.value || '').trim().normalize('NFC');
  console.log('name:', name);
  console.log('existing profiles:', Object.keys(profiles));
  console.log('profiles[name] exists:', profileExists(name));
  
  if (!name) {
    showToast('⚠️ Please enter a profile name!');
    input.focus();
    return;
  }
  if (profileExists(name)) {
    console.log('Profile already exists, details:', profiles[name]);
    showToast('⚠️ Profile already exists!');
    input.focus();
    input.select();
    return;
  }
  
  // Create profile with file-based structure
  profiles[name] = { 
    items: [], 
    createdAt: new Date().toISOString(),
    // New structure for file-based profiles
    boosts: [],
    skins: [],
    wheels: []
  };
  console.log('Creating profile with data:', profiles[name]);
  
  // Request profile folder creation via IPC
  ipcRenderer.invoke('create-profile-folders', { profileName: name })
    .then(result => {
      if (result.success) {
        showToast(`✅ Profile "${name}" created successfully!`);
        console.log('Profile created successfully:', name);
      } else {
        showToast(`❌ Failed to create profile folders: ${result.error}`);
      }
    })
    .catch(error => {
      console.error('Error creating profile folders:', error);
      showToast(`❌ Error: ${error.message}`);
    });
  
  saveProfiles();
  renderProfiles();
  updateProfileDropdowns();
  input.value = '';
}

function renameProfile(oldName, newName) {
  newName = String(newName || '').trim().normalize('NFC');
  if (!newName || newName === oldName) return;
  if (profileExists(newName)) {
    alert('Profile already exists!');
    return;
  }
  profiles[newName] = profiles[oldName];
  delete profiles[oldName];
  saveProfiles();
  renderProfiles();
  updateProfileDropdowns();
}

function deleteProfile(name) {
  // Delete immediately and show toast (user can undo by not refreshing)
  delete profiles[name];
  saveProfiles();
  renderProfiles();
  updateProfileDropdowns();
  showToast(`✅ Profile "${name}" deleted`);
  
  // Force refocus the input immediately
  const input = document.getElementById('newProfileName');
  if (input) {
    input.value = '';
    input.focus();
  }
}

async function loadProfile(name) {
  const profile = profiles[name];
  if (!profile) return;

  // Simple approach: just copy all .upk/.bnk files from profile to CookedPCConsole
  const categories = ['boosts', 'skins', 'wheels'];
  let totalLoaded = 0;
  let failedCount = 0;

  for (const category of categories) {
    const profileFiles = profile[category] || [];
    if (profileFiles.length === 0) continue;

    console.log(`[loadProfile] Loading ${category} from profile "${name}":`, profileFiles);

    try {
      const result = await ipcRenderer.invoke('load-profile-files', { profileName: name, category, files: profileFiles });
      
      if (result.success) {
        totalLoaded += result.loadedCount || 0;
        failedCount += result.failedCount || 0;
      } else {
        console.error(`[loadProfile] Failed to load ${category}:`, result.error);
        failedCount += profileFiles.length;
      }
    } catch (error) {
      console.error(`[loadProfile] Error loading ${category}:`, error);
      failedCount += profileFiles.length;
    }
  }

  // Show result message
  if (failedCount > 0) {
    showToast(`⚠️ Loaded ${totalLoaded} item(s), ${failedCount} failed`);
  } else {
    showToast(`✅ Profile "${name}" loaded successfully (${totalLoaded} items)`);
  }

  // Update swap state to reflect loaded items - clear old swaps for loaded categories
  // and set new swaps based on profile data
  for (const category of categories) {
    const profileFiles = profile[category] || [];
    
    // Clear existing swaps for this category
    Object.keys(remoteCatalogState.swaps).forEach(key => {
      if (key.startsWith(`${category}:`)) {
        delete remoteCatalogState.swaps[key];
      }
    });
    
    // Add new swaps for loaded items (even if filename is null, we know the itemId)
    for (const file of profileFiles) {
      if (file.itemId) {
        remoteCatalogState.swaps[`${category}:${file.itemId}`] = {
          category,
          itemId: file.itemId,
          itemName: file.itemName || 'Unknown',
          files: file.filename ? [file.filename] : []
        };
      }
    }
  }

  // Refresh the UI to show loaded items as enabled
  renderRemoteCategory('boosts');
  renderRemoteCategory('skins');
  renderRemoteCategory('wheels');
}

function addToProfile(category, profileName) {
  if (!profileName) return;
  const profile = profiles[profileName];
  if (!profile) return;

  // Get currently enabled items for this category
  const enabledItems = [];
  Object.keys(remoteCatalogState.swaps).forEach(key => {
    const [cat, itemId] = key.split(':');
    if (cat === category) {
      enabledItems.push({ category, itemId: parseInt(itemId) });
    }
  });

  if (enabledItems.length === 0) {
    showToast('⚠️ No enabled items in this category to add to profile!');
    scheduleEnsureSkinCarSearchUsable();
    return;
  }

  // Copy actual files to profile folder
  ipcRenderer.invoke('add-items-to-profile', { profileName, category, enabledItems })
    .then(result => {
      if (result.success) {
        // Update profile structure with file information
        profile[category] = result.copiedFiles || [];
        
        // Keep backward compatibility
        profile.items = (profile.items || []).filter((i) => i.category !== category);
        enabledItems.forEach((item) => {
          profile.items.push(item);
        });
        
        saveProfiles();
        showToast(`✅ Added ${enabledItems.length} item(s) to profile "${profileName}"`);
      } else {
        showToast(`❌ Failed to add items to profile: ${result.error}`);
      }
    })
    .catch(error => {
      console.error('Error adding items to profile:', error);
      showToast(`❌ Error: ${error.message}`);
    });

  scheduleEnsureSkinCarSearchUsable();
}

function ensureSkinCarSearchUsable() {
  const carInput = document.getElementById('skinCarSearch');
  if (!carInput) return;
  carInput.disabled = false;
  carInput.readOnly = false;
  carInput.tabIndex = 0;
  if (carInput.style) carInput.style.pointerEvents = 'auto';
  const decalPanel = document.getElementById('cd-decal');
  if (decalPanel?.classList?.contains('active')) {
    console.log('[ensureSkinCarSearchUsable] focusing skinCarSearch; activeElement:', document.activeElement?.id);
    carInput.focus();
  }
}

function scheduleEnsureSkinCarSearchUsable() {
  [0, 50, 150, 300].forEach((ms) => {
    setTimeout(() => {
      ensureSkinCarSearchUsable();
      ensurePresetSearchInputsUsable();
    }, ms);
  });
}

function ensurePresetSearchInputsUsable() {
  const ids = [
    'boostCatalogSearch',
    'skinCarSearch',
    'skinCatalogSearch',
    'wheelCatalogSearch',
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = false;
    if ('readOnly' in el) el.readOnly = false;
    if (el.style) el.style.pointerEvents = 'auto';
  });
}

function updateProfileDropdowns() {
  const dropdowns = [
    { id: 'boostProfileSelect', category: 'boosts' },
    { id: 'skinProfileSelect', category: 'skins' },
    { id: 'wheelProfileSelect', category: 'wheels' }
  ];

  dropdowns.forEach(({ id, category }) => {
    const select = document.getElementById(id);
    if (!select) return;

    // Check if any items are enabled in this category
    const hasEnabledItems = Object.keys(remoteCatalogState.swaps).some(key => {
      const [cat] = key.split(':');
      return cat === category;
    });

    const currentVal = select.value;
    select.innerHTML = '<option value="">+ Add to Profile</option>';

    if (hasEnabledItems) {
      Object.keys(profiles).sort().forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
      select.disabled = false;
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '(Enable items first)';
      select.appendChild(option);
      select.disabled = true;
    }

    select.value = currentVal;
  });
}

function renderProfiles() {
  const list = document.getElementById('profileList');
  if (!list) return;

  list.innerHTML = '';
  const profileNames = Object.keys(profiles).sort();

  if (profileNames.length === 0) {
    list.innerHTML = '<div style="font-size:12px; color:#666; text-align:center; padding:20px;">No profiles yet. Create one above!</div>';
    return;
  }

  profileNames.forEach(name => {
    const profile = profiles[name];
    const item = document.createElement('div');
    item.className = 'remote-item';
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <div class="remote-item-main">
        <div class="remote-item-title">${name}</div>
        <div class="remote-item-sub">${profile.items.length} item(s) • Created ${new Date(profile.createdAt).toLocaleDateString()}</div>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-ghost" style="padding:6px 10px; font-size:11px;" onclick="event.stopPropagation(); loadProfile('${name}')">Load</button>
        <button class="btn btn-ghost" style="padding:6px 10px; font-size:11px;" onclick="event.stopPropagation(); renameProfilePrompt('${name}')">Rename</button>
        <button class="btn btn-danger" style="padding:6px 10px; font-size:11px;" onclick="event.stopPropagation(); deleteProfile('${name}')">Delete</button>
      </div>
    `;
    item.onclick = () => loadProfile(name);
    list.appendChild(item);
  });
}

function renameProfilePrompt(name) {
  const newName = prompt(`Rename "${name}" to:`, name);
  if (newName) {
    renameProfile(name, newName);
  }
}

// Initialize profiles on load (deferred until after remoteCatalogState is defined)
function initProfiles() {
  loadProfiles();
  renderProfiles();
  updateProfileDropdowns();
}

// ── Tab switching ──────────────────────────────────────────────────────────

let workshopLoaded     = false;
let workshopPlayLoaded = false;
let workshopCurrentPage  = 1;
let workshopCurrentQuery = '';
let workshopInstalledMapsCache = [];
let workshopPlayFilter = 'all';
let restoreAllWorkshopInProgress = false;
let installedWorkshopIds = new Set();

function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('tab-' + name + '-btn').classList.add('active');
  if (name === 'workshop' && !workshopLoaded) {
    workshopLoaded = true;
    loadBakkesmaps(1, '');
  }
}

function switchCarDesignTab(name) {
  document.querySelectorAll('.cd-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.cd-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('cd-' + name).classList.add('active');
  document.getElementById('cd-' + name + '-btn').classList.add('active');

  ensurePresetSearchInputsUsable();

  const profileNameInput = document.getElementById('newProfileName');
  if (profileNameInput) {
    profileNameInput.disabled = name !== 'profile';
  }

  // If an input from another tab is focused (e.g., profile name), it can remain focused even when hidden.
  // This can make it feel like other inputs (like the car search) are not typable.
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  // Refresh profiles when switching to profile tab
  if (name === 'profile') {
    loadProfiles();
    renderProfiles();
    updateProfileDropdowns();
  }

  // Ensure the car search is focusable when entering the decal tab
  if (name === 'decal') {
    scheduleEnsureSkinCarSearchUsable();
  }
}

const remoteCatalogState = {
  loaded: false,
  categories: { skins: [], wheels: [], boosts: [] },
  swaps: {},
};

// Initialize profiles after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initProfiles();
  
  const profileInput = document.getElementById('newProfileName');
  if (profileInput) {
    profileInput.addEventListener('blur', () => {
      // Ensure input remains focusable after alert
      setTimeout(() => {
        if (document.activeElement !== profileInput && !profileInput.value) {
          // Don't auto-focus, just ensure it's focusable
        }
      }, 100);
    });
  }

  const carInput = document.getElementById('skinCarSearch');
  if (carInput) {
    const recover = () => {
      ensureSkinCarSearchUsable();
    };
    carInput.addEventListener('focus', recover);
    carInput.addEventListener('mousedown', recover);
    carInput.addEventListener('click', recover);
  }

  window.addEventListener('focus', () => {
    const decalPanel = document.getElementById('cd-decal');
    if (decalPanel?.classList?.contains('active')) {
      scheduleEnsureSkinCarSearchUsable();
    }
  });
});

function getRemoteCategoryMeta(category) {
  if (category === 'skins') return { listId: 'skinCatalogList', searchId: 'skinCatalogSearch', statusId: 'skinCatalogStatus', carSearchId: 'skinCarSearch', carSuggestionsId: 'skinCarSuggestions' };
  if (category === 'wheels') return { listId: 'wheelCatalogList', searchId: 'wheelCatalogSearch', statusId: 'wheelCatalogStatus' };
  return { listId: 'boostCatalogList', searchId: 'boostCatalogSearch', statusId: 'boostCatalogStatus' };
}

function populateSkinCarFilter() {
  const input = document.getElementById('skinCarSearch');
  const suggestions = document.getElementById('skinCarSuggestions');
  console.log('populateSkinCarFilter called');
  console.log('input:', input);
  console.log('suggestions:', suggestions);
  console.log('input.disabled:', input?.disabled);
  console.log('input.readonly:', input?.readOnly);
  console.log('input.style:', input?.style?.cssText);
  
  if (!input || !suggestions) {
    console.log('Missing input or suggestions');
    return;
  }
  
  const currentValue = input.value || '';
  const cars = [...new Set((remoteCatalogState.categories.skins || []).map((item) => item.car).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  console.log('cars found:', cars);
  
  suggestions.innerHTML = '';
  cars.forEach((car) => {
    const option = document.createElement('option');
    option.value = car;
    suggestions.appendChild(option);
  });
  if (currentValue && !cars.includes(currentValue)) {
    input.value = '';
  }
  
  // Ensure input is enabled and focusable
  input.disabled = false;
  input.readOnly = false;
  console.log('Input state after fix - disabled:', input.disabled, 'readonly:', input.readOnly);
}

async function refreshRemoteCatalogs() {
  console.log('refreshRemoteCatalogs called');
  const boostStatus = document.getElementById('boostCatalogStatus');
  const skinStatus = document.getElementById('skinCatalogStatus');
  const wheelStatus = document.getElementById('wheelCatalogStatus');
  if (boostStatus) boostStatus.textContent = '⏳ Loading remote catalogs...';
  if (skinStatus) skinStatus.textContent = '⏳ Loading remote catalogs...';
  if (wheelStatus) wheelStatus.textContent = '⏳ Loading remote catalogs...';

  console.log('Calling IPC invoke...');
  const [{ success, categories, error }, swapsRes] = await Promise.all([
    ipcRenderer.invoke('fetch-remote-catalogs'),
    ipcRenderer.invoke('get-remote-swaps'),
  ]);

  console.log('IPC result:', { success, categories, error, swapsRes });

  if (!success) {
    const msg = `❌ ${error || 'Unable to load catalogs'}`;
    console.error('Catalog load failed:', msg);
    if (boostStatus) boostStatus.textContent = msg;
    if (skinStatus) skinStatus.textContent = msg;
    if (wheelStatus) wheelStatus.textContent = msg;
    return;
  }

  console.log('Categories loaded:', categories);
  remoteCatalogState.categories = categories || { skins: [], wheels: [], boosts: [] };
  remoteCatalogState.swaps = swapsRes?.swaps || {};
  remoteCatalogState.loaded = true;

  console.log('Updating UI...');
  populateSkinCarFilter();
  renderRemoteCategory('boosts');
  renderRemoteCategory('skins');
  renderRemoteCategory('wheels');
}

function getSwapKey(category, itemId) {
  return `${category}:${itemId}`;
}

function isRemoteItemEnabled(category, itemId) {
  return Boolean(remoteCatalogState.swaps[getSwapKey(category, itemId)]);
}

function formatInGameApplyName(outputFile) {
  if (!outputFile) return '';
  const base = String(outputFile).replace(/\.(upk|bnk)$/i, '').trim();
  const parts = base.split('_').filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === 'sf') {
    return parts[parts.length - 2].trim();
  }
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferStripesTargetFromDonorFilename(donorFilename) {
  const name = String(donorFilename || '').trim();
  if (!name) return null;
  const m = name.match(/^(skin|Skin)_([^_]+)_.+?_SF\.upk$/);
  if (!m) return null;
  const prefix = m[1];
  const car = m[2];
  return `${prefix}_${car}_Stripes_SF.upk`;
}

function getApplyInGameNameForCategory(category, item) {
  const cat = String(category || '').toLowerCase().trim();
  if (cat === 'boosts') return 'Standard';
  if (cat === 'wheels') return 'Vortex';
  if (cat === 'skins') {
    const donor = item?.assetPackage || item?.outputFile || '';
    const target = inferStripesTargetFromDonorFilename(donor) || 'Stripes_SF.upk';
    return formatInGameApplyName(target);
  }
  return formatInGameApplyName(item?.outputFile || item?.assetPackage || '');
}

function formatWorkshopTargetName(fileName) {
  if (!fileName) return '';
  const base = String(fileName).replace(/_P\.upk$/i, '').replace(/\.(upk|udk|umap)$/i, '').trim();
  const parts = base.split('_').filter(Boolean);
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === 'sf') {
    return parts[parts.length - 2].trim();
  }
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderRemoteCategory(category) {
  const meta = getRemoteCategoryMeta(category);
  const listEl = document.getElementById(meta.listId);
  const statusEl = document.getElementById(meta.statusId);
  if (!listEl || !statusEl) return;

  if (!remoteCatalogState.loaded) {
    listEl.innerHTML = '';
    statusEl.textContent = '⏳ Loading...';
    return;
  }

  const searchEl = document.getElementById(meta.searchId);
  const query = String(searchEl?.value || '').toLowerCase().trim();

  const carSearchEl = document.getElementById('skinCarSearch');
  const selectedCarQuery = String(carSearchEl?.value || '').toLowerCase().trim();

  const all = remoteCatalogState.categories[category] || [];
  const skinsHaveCarField = category === 'skins' && (all || []).some((item) => Boolean(item?.car));

  // Check if there are skins without a car field
  const hasSkinsWithoutCar = all.some(item => !item.car || item.car.trim() === '');
  // Only block if all skins have a car field AND no car is selected
  if (category === 'skins' && skinsHaveCarField && !hasSkinsWithoutCar && !selectedCarQuery) {
    listEl.innerHTML = '';
    statusEl.textContent = '🔒 Select a car first to unlock decals';
    return;
  }

  let filtered = all.filter((item) => {
    // For skins, apply car filter first
    if (category === 'skins' && selectedCarQuery) {
      const carName = (item.car || '').toLowerCase();
      // Show skins without a car regardless of filter, but filter others by car
      if (carName && !carName.includes(selectedCarQuery)) return false;
    }
    // Then apply text search filter
    if (!query) return true;
    const hay = `${item.name || ''} ${item.subtitle || ''} ${item.car || ''}`.toLowerCase();
    return hay.includes(query);
  }).slice(0, 350);

  // Always include enabled items even if they don't match the text filter (but respect car filter)
  const enabledItems = all.filter(item => isRemoteItemEnabled(category, item.id));
  enabledItems.forEach(enabledItem => {
    // Check if already in filtered list
    if (filtered.some(f => f.id === enabledItem.id)) return;
    
    // For skins, only add if it matches the car filter (or no car filter set)
    if (category === 'skins' && selectedCarQuery) {
      const carName = (enabledItem.car || '').toLowerCase();
      // Only add enabled items that match the car filter
      if (carName && !carName.includes(selectedCarQuery)) return;
    }
    
    filtered.push(enabledItem);
  });

  listEl.innerHTML = '';

  // Trie : activés en premier
  const sorted = [...filtered].sort((a, b) => {
    const aEnabled = isRemoteItemEnabled(category, a.id) ? 1 : 0;
    const bEnabled = isRemoteItemEnabled(category, b.id) ? 1 : 0;
    return bEnabled - aEnabled;
  });

  sorted.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'remote-item';

    const left = document.createElement('div');
    left.className = 'remote-item-main';
    const inGameApplyName = getApplyInGameNameForCategory(category, item);

    // Get swap direction: source -> target
    let swapDirection = '';
    if (category === 'skins') {
      const donor = item?.assetPackage || item?.outputFile || '';
      const target = inferStripesTargetFromDonorFilename(donor) || 'Stripes_SF.upk';
      const sourceName = formatInGameApplyName(donor);
      const targetName = formatInGameApplyName(target);
      swapDirection = `${sourceName} → ${targetName}`;
    } else if (category === 'boosts') {
      swapDirection = `${item.name || 'Unknown'} → Standard`;
    } else if (category === 'wheels') {
      swapDirection = `${item.name || 'Unknown'} → Vortex`;
    }

    left.innerHTML = `
      <div class="remote-item-title">${item.name || 'Unnamed'}</div>
      <div class="remote-item-sub">${swapDirection}</div>
      <div class="remote-item-sub" style="color:#f59e0b;">🎮 Apply in game: <strong style="color:#fbbf24;">${inGameApplyName || 'Unknown item'}</strong></div>
    `;

    const enabled = isRemoteItemEnabled(category, item.id);
    const action = document.createElement('button');
    action.className = enabled ? 'btn btn-danger' : 'btn btn-ghost';
    const canApply = Boolean(item?.assetPackage || item?.outputFile || (Array.isArray(item.remoteFiles) && item.remoteFiles.length > 0));
    if (!canApply) {
      action.textContent = 'N/A';
      action.disabled = true;
      action.className = 'btn btn-ghost';
    } else {
      action.textContent = enabled ? 'Disable' : 'Enable';
      action.onclick = () => toggleRemoteItem(category, item, action);
    }

    row.appendChild(left);
    row.appendChild(action);
    listEl.appendChild(row);
  });

  if (!filtered.length) {
    statusEl.textContent = '📭 No item found';
  } else if (filtered.length < all.length) {
    statusEl.textContent = `Showing ${filtered.length}/${all.length} items`;
  } else {
    statusEl.textContent = `${all.length} items`;
  }
}

async function toggleRemoteItem(category, item, button) {
  const currentlyEnabled = isRemoteItemEnabled(category, item.id);
  if (button) {
    button.disabled = true;
    button.textContent = currentlyEnabled ? '⏳ Reverting...' : '⏳ Applying...';
  }

  console.log(`[toggleRemoteItem] Starting ${currentlyEnabled ? 'revert' : 'apply'} for ${category}:${item.id} (${item.name})`);

  let res;
  if (currentlyEnabled) {
    console.log(`[toggleRemoteItem] Calling revert-remote-item...`);
    res = await ipcRenderer.invoke('revert-remote-item', { category, itemId: item.id });
    console.log(`[toggleRemoteItem] Revert result:`, res);
    if (res.success) {
      delete remoteCatalogState.swaps[getSwapKey(category, item.id)];
      const itemName = item.name || `Item ${item.id}`;
      showToast(`✅ ${itemName} restored to original`);
    } else {
      // If revert failed due to missing swap state, clean up local state
      if (res.error && res.error.includes('No swap state found')) {
        console.warn(`[toggleRemoteItem] Removing orphaned swap state for ${category}:${item.id}`);
        delete remoteCatalogState.swaps[getSwapKey(category, item.id)];
        const itemName = item.name || `Item ${item.id}`;
        showToast(`⚠️ ${itemName} state was inconsistent, cleaned up`);
        res.success = true; // Treat as success since we cleaned up
      } else {
        const itemName = item.name || `Item ${item.id}`;
        showToast(`❌ Failed to restore ${itemName}: ${res.error}`);
      }
    }
  } else {
    // Enforce: only one enabled item per category.
    // Before applying, revert any other enabled item in the same category.
    const otherEnabledIds = Object.keys(remoteCatalogState.swaps)
      .filter((k) => k.startsWith(`${category}:`))
      .map((k) => Number(String(k).split(':')[1]))
      .filter((id) => Number.isFinite(id) && id !== item.id);

    for (const otherId of otherEnabledIds) {
      try {
        const r = await ipcRenderer.invoke('revert-remote-item', { category, itemId: otherId });
        if (r?.success) delete remoteCatalogState.swaps[getSwapKey(category, otherId)];
      } catch (e) {
        // ignore and continue
      }
    }

    console.log(`[toggleRemoteItem] Calling apply-remote-item with:`, { category, itemId: item.id, assetPackage: item.assetPackage, outputFile: item.outputFile });
    res = await ipcRenderer.invoke('apply-remote-item', { category, itemId: item.id });
    console.log(`[toggleRemoteItem] Apply result:`, res);
    if (res.success) {
      Object.keys(remoteCatalogState.swaps).forEach((k) => {
        if (k.startsWith(`${category}:`)) {
          const rec = remoteCatalogState.swaps[k];
          if (rec?.files?.some((f) => (res.files || []).includes(f))) delete remoteCatalogState.swaps[k];
        }
      });
      remoteCatalogState.swaps[getSwapKey(category, item.id)] = {
        category,
        itemId: item.id,
        itemName: item.name,
        files: res.files || [],
      };
      showToast(`✅ ${item.name} enabled`);
    }
  }

  if (!res?.success) {
    showToast(`❌ ${res?.error || 'Operation failed'}`);
  }

  renderRemoteCategory(category);
  updateProfileDropdowns();
}


let restoreAllInProgress = false;

function setRestoreAllProgress(percent, statusText) {
  const track = document.getElementById('restoreAllProgressTrack');
  const fill = document.getElementById('restoreAllProgressFill');
  const status = document.getElementById('restoreAllOriginalStatus');
  if (!track || !fill || !status) return;

  if (typeof percent === 'number') {
    track.style.display = '';
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  if (statusText) status.textContent = statusText;
}

function restoreAllOriginalFiles() {
  if (restoreAllInProgress) return;
  restoreAllInProgress = true;

  const btn = document.getElementById('restoreAllOriginalBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Restoring...';
  }

  setRestoreAllProgress(0, 'Preparing...');
  ipcRenderer.send('revert-all-remote-items');
}

ipcRenderer.on('revert-all-remote-progress', async (_, payload) => {
  const btn = document.getElementById('restoreAllOriginalBtn');
  const track = document.getElementById('restoreAllProgressTrack');
  if (!payload?.success) {
    restoreAllInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '♻️ Restore all original files';
    }
    if (track) track.style.display = 'none';
    setRestoreAllProgress(null, `❌ ${payload?.error || 'Restore failed'}`);
    showToast(`❌ ${payload?.error || 'Restore failed'}`);
    return;
  }

  const done = payload.done || 0;
  const total = payload.total || 0;
  const percent = typeof payload.percent === 'number' ? payload.percent : 0;
  const statusText = total > 0 ? `Restoring... ${done}/${total} (${percent}%)` : (payload.message || 'Done');
  setRestoreAllProgress(percent, statusText);

  if (!payload.finished) return;

  restoreAllInProgress = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '♻️ Restore all original files';
  }
  if (track) {
    setTimeout(() => { track.style.display = 'none'; }, 1200);
  }
  setRestoreAllProgress(100, '✅ All original files restored');
  showToast('✅ All original files restored');

  await refreshRemoteCatalogs();
});

function switchWorkshopTab(name) {
  document.querySelectorAll('.ws-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ws-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('ws-' + name).classList.add('active');
  document.getElementById('ws-' + name + '-btn').classList.add('active');
  if (name === 'play' && !workshopPlayLoaded) {
    workshopPlayLoaded = true;
    loadInstalledMaps();
  }
}

function workshopSearch() {
  const q = document.getElementById('workshopSearch').value.trim();
  workshopCurrentQuery = q;
  loadBakkesmaps(1, q);
}

async function loadBakkesmaps(page, query) {
  workshopCurrentPage = page;
  const status     = document.getElementById('workshop-status');
  const grid       = document.getElementById('workshop-grid');
  const count      = document.getElementById('workshop-count');
  const pagination = document.getElementById('workshop-pagination');

  status.textContent   = '⏳ Loading...';
  status.style.display = 'block';
  grid.innerHTML       = '';
  count.textContent    = '';
  pagination.innerHTML = '';

  const [{ maps, totalPages, error }, installedRes] = await Promise.all([
    ipcRenderer.invoke('fetch-bakkesmaps', { page, query }),
    ipcRenderer.invoke('get-installed-maps'),
  ]);

  installedWorkshopIds = new Set(
    (installedRes?.maps || [])
      .map((m) => String(m?.id || '').trim())
      .filter(Boolean)
  );

  if (error || !maps.length) {
    status.textContent = error ? '❌ ' + error : '📭 No maps found';
    return;
  }

  status.style.display = 'none';
  count.textContent    = query ? `Results for "${query}"` : `Page ${page} / ${totalPages}`;

  maps.forEach(m => grid.appendChild(buildBakkesCard(m)));

  // Pagination
  if (totalPages > 1) {
    if (page > 1) {
      const prev = document.createElement('button');
      prev.className   = 'btn btn-ghost';
      prev.textContent = '← Prev';
      prev.style.fontSize = '11px';
      prev.onclick = () => loadBakkesmaps(page - 1, query);
      pagination.appendChild(prev);
    }
    const info = document.createElement('span');
    info.style.cssText = 'font-size:11px; color:#555; align-self:center;';
    info.textContent   = `${page} / ${totalPages}`;
    pagination.appendChild(info);
    if (page < totalPages) {
      const next = document.createElement('button');
      next.className   = 'btn btn-ghost';
      next.textContent = 'Next →';
      next.style.fontSize = '11px';
      next.onclick = () => loadBakkesmaps(page + 1, query);
      pagination.appendChild(next);
    }
  }
}

function buildBakkesCard(map) {
  const card = document.createElement('div');
  card.className = 'map-card';

  if (map.image) {
    const img = document.createElement('img');
    img.src     = map.image;
    img.alt     = map.name;
    img.onerror = () => img.replaceWith(makePlaceholder());
    card.appendChild(img);
  } else {
    card.appendChild(makePlaceholder());
  }

  const label = document.createElement('div');
  label.className   = 'map-card-name';
  label.textContent = map.name;
  label.title       = map.name;
  card.appendChild(label);

  if (map.author) {
    const auth = document.createElement('div');
    auth.style.cssText  = 'font-size:10px; color:#555; padding: 0 10px 4px;';
    auth.textContent    = 'by ' + map.author;
    card.appendChild(auth);
  }

  const btn = document.createElement('button');
  const isInstalled = installedWorkshopIds.has(String(map.id || ''));
  btn.className   = isInstalled ? 'btn btn-ghost' : 'btn btn-primary';
  btn.textContent = isInstalled ? '✅ Downloaded' : '⬇ Install';
  btn.id          = `install-${map.id}`;
  btn.style.cssText = 'width:100%; border-radius:0 0 10px 10px; font-size:11px; padding:7px;';
  btn.disabled = isInstalled;
  btn.onclick = () => installBakkesmap(map.id, map.name, btn);
  card.appendChild(btn);

  return card;
}

async function installBakkesmap(id, name, btn) {
  btn.textContent = '⏳ Downloading...';
  btn.disabled    = true;

  const { success, error } = await ipcRenderer.invoke('install-bakkesmap', { id, name });

  if (success) {
    btn.textContent  = '✅ Downloaded';
    btn.className    = 'btn btn-ghost';
    btn.style.color  = '#10b981';
    btn.disabled     = true;
    installedWorkshopIds.add(String(id));
    workshopPlayLoaded = false;
  } else {
    btn.textContent = '❌ Error';
    btn.title       = error;
    btn.disabled    = false;
  }
}

async function loadInstalledMaps() {
  const status = document.getElementById('play-status');
  const grid   = document.getElementById('play-grid');

  status.textContent   = '⏳ Loading...';
  status.style.display = 'block';
  grid.innerHTML       = '';

  const { maps, error } = await ipcRenderer.invoke('get-installed-maps');
  workshopInstalledMapsCache = Array.isArray(maps) ? maps : [];

  if (error || !workshopInstalledMapsCache.length) {
    status.textContent = error ? '❌ ' + error : '📭 No maps installed';
    applyWorkshopPlayFilterUI();
    return;
  }

  renderInstalledMapsFiltered();
}

function setWorkshopPlayFilter(filter) {
  workshopPlayFilter = filter === 'added' ? 'added' : 'all';
  applyWorkshopPlayFilterUI();
  renderInstalledMapsFiltered();
}

function applyWorkshopPlayFilterUI() {
  const allBtn = document.getElementById('playFilterAllBtn');
  const addedBtn = document.getElementById('playFilterAddedBtn');
  if (allBtn) allBtn.className = workshopPlayFilter === 'all' ? 'btn btn-primary' : 'btn btn-ghost';
  if (addedBtn) addedBtn.className = workshopPlayFilter === 'added' ? 'btn btn-primary' : 'btn btn-ghost';
}

function renderInstalledMapsFiltered() {
  const status = document.getElementById('play-status');
  const grid = document.getElementById('play-grid');
  if (!status || !grid) return;

  applyWorkshopPlayFilterUI();
  grid.innerHTML = '';

  const filtered = workshopPlayFilter === 'added'
    ? workshopInstalledMapsCache.filter((m) => Boolean(m.install))
    : workshopInstalledMapsCache;

  if (!filtered.length) {
    status.style.display = 'block';
    status.textContent = workshopPlayFilter === 'added'
      ? '📭 No active maps yet'
      : '📭 No maps installed';
    return;
  }

  status.style.display = 'none';
  filtered.forEach(m => grid.appendChild(buildInstalledCard(m)));
}

function buildInstalledCard(map) {
  const card = document.createElement('div');
  card.className = 'map-card';

  if (map.image) {
    const img = document.createElement('img');
    img.src     = map.image;
    img.alt     = map.name;
    img.onerror = () => img.replaceWith(makePlaceholder());
    card.appendChild(img);
  } else {
    card.appendChild(makePlaceholder());
  }

  const label = document.createElement('div');
  label.className   = 'map-card-name';
  label.textContent = map.name;
  label.title       = map.name;
  card.appendChild(label);

  if (map.install) {
    label.style.paddingBottom = '4px';
    const mapName = formatWorkshopTargetName(map.install.targetMapFile);

    const info = document.createElement('div');
    info.style.cssText = 'font-size:10px; color:#10b981; padding:4px 10px; display:flex; align-items:center; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.06);';
    info.innerHTML = `<span>✅ Active on <strong>${mapName}</strong></span>`;
    card.appendChild(info);

    const launchHint = document.createElement('div');
    launchHint.style.cssText = 'font-size:10px; color:#f59e0b; padding:4px 10px; border-top:1px solid rgba(245,158,11,0.15);';
    launchHint.innerHTML = `🎮 Launch in game: <strong style="color:#fbbf24;">${mapName}</strong>`;
    card.appendChild(launchHint);

    const revertBtn = document.createElement('button');
    revertBtn.textContent = '↩ Revert to Original';
    revertBtn.style.cssText = [
      'width:100%', 'border:none', 'background:rgba(245,158,11,0.1)',
      'color:#f59e0b', 'font-size:11px', 'padding:7px', 'cursor:pointer',
      'border-top:1px solid rgba(245,158,11,0.15)', 'transition:background 0.15s',
      'border-radius:0 0 10px 10px',
    ].join(';');
    revertBtn.onmouseenter = () => revertBtn.style.background = 'rgba(245,158,11,0.2)';
    revertBtn.onmouseleave = () => revertBtn.style.background = 'rgba(245,158,11,0.1)';
    revertBtn.onclick = () => confirmRevert(map, revertBtn);
    card.appendChild(revertBtn);

  } else {
    const playBtn = document.createElement('button');
    playBtn.className   = 'btn btn-primary';
    playBtn.textContent = '▶ Play';
    playBtn.style.cssText = 'width:100%; border-radius:0 0 10px 10px; font-size:11px; padding:7px;';
    playBtn.onclick = () => openMapSelector(map);
    card.appendChild(playBtn);
  }

  return card;
}

// ── Sélecteur de map RL ────────────────────────────────────────────────────────

let currentWorkshopMap = null;
let rlMapsCache        = [];

async function openMapSelector(map) {
  currentWorkshopMap = map;
  document.getElementById('rl-modal-title').textContent = `"${map.name}" → which RL map to replace?`;
  document.getElementById('rl-confirm').style.display  = 'none';
  document.getElementById('rl-map-search').value       = '';
  document.getElementById('rl-map-modal').style.display = 'flex';

  if (!rlMapsCache.length) {
    document.getElementById('rl-map-list').innerHTML = '<div class="workshop-empty">⏳ Loading RL maps...</div>';
    const { maps, error } = await ipcRenderer.invoke('get-rl-maps');
    if (error || !maps.length) {
      document.getElementById('rl-map-list').innerHTML = `<div class="workshop-empty">❌ ${error || 'No maps found'}</div>`;
      return;
    }
    rlMapsCache = maps;
  }
  renderRLMapList('');
}

function filterRLMaps(q) { renderRLMapList(q); }

function renderRLMapList(query) {
  const list = document.getElementById('rl-map-list');
  list.innerHTML = '';
  const q = (query || '').toLowerCase();

  const filtered = rlMapsCache.filter(m =>
    !m.inUse &&
    (!q || m.displayName.toLowerCase().includes(q) || m.fileName.toLowerCase().includes(q))
  );

  // Recommended first, then alpha
  filtered.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  filtered.forEach(m => {
    const item = document.createElement('div');
    item.className = 'rl-map-item';
    item.innerHTML = `<span>${m.displayName}</span>${m.recommended ? '<span class="recommended-badge">recommended</span>' : ''}`;
    item.onclick   = () => showConfirm(m);
    list.appendChild(item);
  });

  if (!filtered.length) {
    list.innerHTML = '<div class="workshop-empty">📭 No maps found</div>';
  }
}

function showConfirm(rlMap) {
  const panel = document.getElementById('rl-confirm');
  document.getElementById('rl-confirm-msg').innerHTML =
    `Replace <strong style="color:#eee">${rlMap.displayName}</strong> with <strong style="color:#a78bfa">${currentWorkshopMap.name}</strong>?<br><br>` +
    `<span style="color:#666;font-size:11px;">You can always restore the original map using the Revert button.</span>`;
  document.getElementById('rl-confirm-yes').onclick  = () => doInstallMap(rlMap);
  document.getElementById('rl-confirm-yes').textContent = '✅ Confirm';
  document.getElementById('rl-confirm-yes').disabled = false;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
}

async function doInstallMap(rlMap) {
  const btn = document.getElementById('rl-confirm-yes');
  btn.textContent = '⏳ Installing...';
  btn.disabled    = true;

  const { success, error } = await ipcRenderer.invoke('load-workshop-map', {
    zipFileName   : currentWorkshopMap.fileName,
    targetMapFile : rlMap.fileName,
  });

  closeMapModal();

  if (success) {
    rlMapsCache = [];
    workshopPlayLoaded = false;
    loadInstalledMaps();
    showToast(`✅ "${currentWorkshopMap.name}" installed`);
  } else {
    showToast(`❌ Error: ${error}`);
  }
}

function confirmRevert(map, revertBtn) {
  revertBtn.style.display = 'none';
  const card = revertBtn.parentElement;

  const confirmBox = document.createElement('div');
  confirmBox.style.cssText = [
    'padding:8px 10px', 'background:rgba(245,158,11,0.08)',
    'border-top:1px solid rgba(245,158,11,0.15)',
    'border-radius:0 0 10px 10px',
  ].join(';');
  confirmBox.innerHTML =
    `<div style="font-size:10px;color:#f59e0b;margin-bottom:6px;line-height:1.5;">⚠️ Restore original map?<br>` +
    `<span style="color:#666;">This will restore the selected original map.</span></div>` +
    `<div style="display:flex;gap:6px;">` +
      `<button style="flex:1;padding:5px;font-size:10px;border:none;border-radius:6px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;cursor:pointer;">✅ Confirm</button>` +
      `<button style="flex:1;padding:5px;font-size:10px;border:none;border-radius:6px;background:rgba(255,255,255,0.07);color:#aaa;cursor:pointer;">✕ Cancel</button>` +
    `</div>`;

  confirmBox.querySelectorAll('button')[1].onclick = () => { confirmBox.remove(); revertBtn.style.display = ''; };
  confirmBox.querySelectorAll('button')[0].onclick = () => { confirmBox.remove(); revertWorkshopMap(map, revertBtn); };

  card.appendChild(confirmBox);
}

async function revertWorkshopMap(map, btn) {
  btn.textContent = '⏳ Reverting...';
  btn.disabled    = true;

  const { success, error, targetMapFile } = await ipcRenderer.invoke('revert-workshop-map', { zipFileName: map.fileName });

  if (success) {
    rlMapsCache = [];
    workshopPlayLoaded = false;
    await loadInstalledMaps();
    showToast(`✅ Original "${targetMapFile.replace(/_P\.upk$/i, '').replace(/_/g, ' ')}" restored`);
  } else {
    showToast(`❌ Error: ${error}`);
    btn.textContent = '↩ Revert to Original';
    btn.disabled    = false;
  }
}

function setWorkshopActionStatus(text) {
  const status = document.getElementById('playActionsStatus');
  if (status) status.textContent = text || '';
}

function restoreAllWorkshopMaps() {
  if (restoreAllWorkshopInProgress) return;
  restoreAllWorkshopInProgress = true;

  const btn = document.getElementById('restoreAllWorkshopBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Restoring...';
  }
  setWorkshopActionStatus('Preparing restore...');
  ipcRenderer.send('revert-all-workshop-maps');
}

ipcRenderer.on('revert-all-workshop-progress', async (_, payload) => {
  const btn = document.getElementById('restoreAllWorkshopBtn');
  if (!payload?.success) {
    restoreAllWorkshopInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '♻️ Restore all original maps';
    }
    setWorkshopActionStatus(`❌ ${payload?.error || 'Restore failed'}`);
    showToast(`❌ ${payload?.error || 'Restore failed'}`);
    return;
  }

  const done = payload.done || 0;
  const total = payload.total || 0;
  if (!payload.finished) {
    setWorkshopActionStatus(`Restoring maps... ${done}/${total} (${payload.percent || 0}%)`);
    return;
  }

  restoreAllWorkshopInProgress = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = '♻️ Restore all original maps';
  }
  setWorkshopActionStatus('✅ All workshop maps restored');
  workshopPlayLoaded = false;
  await loadInstalledMaps();
  showToast('✅ All workshop maps restored');
});

function showToast(msg) {
  const notif = document.createElement('div');
  notif.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2000;background:#1a1a2e;border:1px solid rgba(167,139,250,0.4);border-radius:10px;padding:12px 18px;font-size:12px;color:#ccc;max-width:320px;pointer-events:none;';
  notif.textContent = msg;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 4000);
}

function closeMapModal() {
  document.getElementById('rl-map-modal').style.display = 'none';
  document.getElementById('rl-confirm').style.display   = 'none';
}

function makePlaceholder() {
  const d = document.createElement('div');
  d.className   = 'map-card-placeholder';
  d.textContent = '🗺️';
  return d;
}

function openExternal(url) {
  const { shell } = require('electron');
  shell.openExternal(url);
}

// ── Startup ────────────────────────────────────────────────────────────────

ipcRenderer.send('get-state');
refreshRemoteCatalogs();

// ── RL connection ──────────────────────────────────────────────────────────

ipcRenderer.on('state-update', (event, state) => {
  updateUI(state);
});

ipcRenderer.on('rl-connected', (event, connected) => {
  const dot    = document.getElementById('rlDot');
  const status = document.getElementById('rlStatus');
  if (connected) {
    dot.classList.add('on');
    status.textContent = 'Connected';
  } else {
    dot.classList.remove('on');
    status.textContent = 'Offline';
  }
});

ipcRenderer.on('player-name', (event, name) => {
  const el = document.getElementById('playerName');
  if (el) el.textContent = '👤 ' + name;
});

ipcRenderer.on('mmr-source', (event, source) => {
  const el = document.getElementById('mmrSource');
  if (!el) return;
  if (source === 'real') {
    el.textContent = '✅ Real MMR';
    el.className   = 'mmr-source real';
  } else if (source === 'fetching') {
    el.textContent = '🔄 Fetching real MMR...';
    el.className   = 'mmr-source fetching';
  } else {
    el.textContent = '⚠️ Estimated MMR';
    el.className   = 'mmr-source estimated';
  }
});

// ── UI update ──────────────────────────────────────────────────────────────

function updateUI(state) {
  document.getElementById('mmrBig').textContent    = state.mmr;
  console.log('[updateUI] rankImageUrl:', state.rankImageUrl);
  console.log('[updateUI] mmr:', state.mmr);

  const rk = document.getElementById('mmrRankImg');
  if (rk) {
    if (state.rankImageUrl) {
      if (rk.getAttribute('data-src-active') !== state.rankImageUrl) {
        rk.setAttribute('data-src-active', state.rankImageUrl);
        rk.style.display = 'block'; // ← force display AVANT de setter src
        rk.src = state.rankImageUrl;
      } else {
        rk.style.display = 'block'; // ← déjà en cache, force quand même
      }
      rk.onerror = () => { rk.style.display = 'none'; };
    } else {
      rk.removeAttribute('data-src-active');
      rk.removeAttribute('src');
      rk.style.display = 'none';
    }
  }

  document.getElementById('winsVal').textContent   = state.wins;
  document.getElementById('lossesVal').textContent = state.losses;

  const total = state.wins + state.losses;
  const ratio = total > 0 ? Math.round((state.wins / total) * 100) + '%' : '—';
  document.getElementById('ratioVal').textContent = ratio;

  const streakEl = document.getElementById('streakPill');
  if (state.streak > 0) {
    streakEl.className   = 'streak-pill win-streak';
    streakEl.textContent = `🔥 ${state.streak} win streak`;
  } else if (state.streak < 0) {
    streakEl.className   = 'streak-pill loss-streak';
    streakEl.textContent = `❄️ ${Math.abs(state.streak)} loss streak`;
  } else {
    streakEl.className   = 'streak-pill neutral';
    streakEl.textContent = 'No streak';
  }

  const gained   = state.mmrGained || 0;
  const gainedEl = document.getElementById('mmrGainedEl');
  if (gainedEl) {
    if (gained > 0) {
      gainedEl.style.color = '#10b981';
      gainedEl.textContent = `📈 +${gained} this session`;
    } else if (gained < 0) {
      gainedEl.style.color = '#ef4444';
      gainedEl.textContent = `📉 ${gained} this session`;
    } else {
      gainedEl.style.color = '#666';
      gainedEl.textContent = `Δ 0 this session`;
    }
  }

  document.getElementById('widthInput').value  = state.overlayWidth;
  document.getElementById('heightInput').value = state.overlayHeight;
}

// ── Player overlays ────────────────────────────────────────────────────────

let playerOverlaysEnabled = false;

ipcRenderer.on('player-overlays-state', (_, enabled) => {
  playerOverlaysEnabled = enabled;
  const btn    = document.getElementById('togglePlayerOverlaysBtn');
  const status = document.getElementById('playerOverlaysStatus');
  btn.textContent  = enabled ? 'Disable' : 'Enable';
  btn.className    = enabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent  = enabled ? 'Enabled' : 'Disabled';
  status.style.color  = enabled ? '#10b981' : '#666';
  ipcRenderer.send('toggle-player-overlays', enabled);
});

function togglePlayerOverlays() {
  playerOverlaysEnabled = !playerOverlaysEnabled;
  ipcRenderer.send('toggle-player-overlays', playerOverlaysEnabled);
  document.getElementById('togglePlayerOverlaysBtn').textContent = playerOverlaysEnabled ? 'Disable' : 'Enable';
  document.getElementById('togglePlayerOverlaysBtn').className   = playerOverlaysEnabled ? 'btn btn-danger' : 'btn btn-ghost';
  document.getElementById('playerOverlaysStatus').textContent    = playerOverlaysEnabled ? 'Enabled' : 'Disabled';
  document.getElementById('playerOverlaysStatus').style.color    = playerOverlaysEnabled ? '#10b981' : '#666';
}

// ── Boost ──────────────────────────────────────────────────────────────────

let boostEnabled = false;

ipcRenderer.on('boost-state', (_, enabled) => {
  boostEnabled = enabled;
  const btn    = document.getElementById('toggleBoostBtn');
  const status = document.getElementById('boostStatus');
  btn.textContent    = enabled ? 'Disable' : 'Enable';
  btn.className      = enabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent = enabled ? 'Enabled' : 'Disabled';
  status.style.color = enabled ? '#10b981' : '#666';
});

function toggleBoost() {
  boostEnabled = !boostEnabled;
  const btn    = document.getElementById('toggleBoostBtn');
  const status = document.getElementById('boostStatus');
  const msg    = document.getElementById('boostStatusMsg');

  btn.textContent    = boostEnabled ? 'Disable' : 'Enable';
  btn.className      = boostEnabled ? 'btn btn-danger' : 'btn btn-ghost';
  status.textContent = boostEnabled ? 'Enabled' : 'Disabled';
  status.style.color = boostEnabled ? '#10b981' : '#666';
  msg.textContent    = '⏳ Applying...';

  ipcRenderer.send('toggle-boost', boostEnabled);
  document.getElementById('restartWarning').style.display = 'block';
}

ipcRenderer.on('boost-result', (_, result) => {
  const msg = document.getElementById('boostStatusMsg');
  msg.textContent = result.success
    ? (result.enabled ? '✅ Alpha Boost enabled' : '✅ Original boost restored')
    : '❌ Error: ' + result.error;
});

// ── MMR / stats ────────────────────────────────────────────────────────────

function refreshMMR() {
  ipcRenderer.send('refresh-mmr');
}

function resetStats() {
  ipcRenderer.send('reset-stats');
}

// ── Overlay size ───────────────────────────────────────────────────────────

function applySize() {
  const width  = parseInt(document.getElementById('widthInput').value)  || 220;
  const height = parseInt(document.getElementById('heightInput').value) || 160;
  ipcRenderer.send('set-overlay-size', { width, height });
}

// ── Scoreboard key binding ─────────────────────────────────────────────────

let isBinding = false;

function startBinding() {
  isBinding = true;
  document.getElementById('bindStatus').textContent  = '⏳ Appuie sur une touche clavier ou bouton manette...';
  document.getElementById('bindBtn').textContent     = 'Annuler';
  document.getElementById('bindBtn').onclick         = cancelBinding;
  ipcRenderer.send('start-binding');
}

function cancelBinding() {
  isBinding = false;
  document.getElementById('bindStatus').textContent = '';
  document.getElementById('bindBtn').textContent    = 'Bind';
  document.getElementById('bindBtn').onclick        = startBinding;
  ipcRenderer.send('stop-binding');
}

function clearBinding() {
  ipcRenderer.send('clear-binding');
  document.getElementById('scoreboardKeyDisplay').textContent = 'Non configuré';
}

ipcRenderer.on('binding-captured', (_, key) => {
  isBinding = false;
  document.getElementById('scoreboardKeyDisplay').textContent = key.label;
  document.getElementById('bindStatus').textContent           = '✅ Touche enregistrée';
  document.getElementById('bindBtn').textContent              = 'Bind';
  document.getElementById('bindBtn').onclick                  = startBinding;
});

ipcRenderer.on('scoreboard-key', (_, key) => {
  if (key) document.getElementById('scoreboardKeyDisplay').textContent = key.label;
});

// ── MMR input enter key ────────────────────────────────────────────────────

const mmrInput = document.getElementById('mmrInput');
if (mmrInput) {
  mmrInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setMMR();
  });
}

// ── Production tab ─────────────────────────────────────────────────────────

// Auto-save production config to main process whenever any field changes
function prodAutoSave() {
  ipcRenderer.send('prod-config-update', getProdConfig());
}

// Collect all production field values into one object
function getProdConfig() {
  return {
    eventName:  document.getElementById('prodEventName').value,
    round:      document.getElementById('prodRound').value,
    format:     document.getElementById('prodFormat').value,
    blueTeam:   document.getElementById('prodBlueTeam').value,
    blueLogo:   document.getElementById('prodBlueLogo').value,
    orangeTeam: document.getElementById('prodOrangeTeam').value,
    orangeLogo: document.getElementById('prodOrangeLogo').value,
  };
}

// Push config to overlay and show confirmation
function prodApply() {
  const config = getProdConfig();
  ipcRenderer.send('prod-config-update', config);
  const el = document.getElementById('prodStatus');
  el.textContent = '✅ Applied to overlay';
  setTimeout(() => { el.textContent = ''; }, 2500);
}

// Receive production config from main (e.g. on startup to restore saved values)
ipcRenderer.on('prod-config', (_, config) => {
  if (!config) return;
  if (config.eventName  !== undefined) document.getElementById('prodEventName').value  = config.eventName;
  if (config.round      !== undefined) document.getElementById('prodRound').value       = config.round;
  if (config.format     !== undefined) document.getElementById('prodFormat').value      = config.format;
  if (config.blueTeam   !== undefined) document.getElementById('prodBlueTeam').value    = config.blueTeam;
  if (config.blueLogo   !== undefined) document.getElementById('prodBlueLogo').value    = config.blueLogo;
  if (config.orangeTeam !== undefined) document.getElementById('prodOrangeTeam').value  = config.orangeTeam;
  if (config.orangeLogo !== undefined) document.getElementById('prodOrangeLogo').value  = config.orangeLogo;
});

// Update overlay server status dot
ipcRenderer.on('prod-server-status', (_, online) => {
  const dot    = document.getElementById('serverDot');
  const status = document.getElementById('serverStatus');
  if (online) {
    dot.style.background    = '#10b981';
    dot.style.animation     = 'pulse 2s infinite';
    status.textContent      = 'Server running — localhost:3000';
  } else {
    dot.style.background    = '#ef4444';
    dot.style.animation     = 'none';
    status.textContent      = 'Server offline';
  }
});

let prodOverlayVisible = false;
document.getElementById('toggle-prod-overlay').addEventListener('click', () => {
  prodOverlayVisible = !prodOverlayVisible;
  ipcRenderer.send('toggle-prod-overlay', prodOverlayVisible);
  const btn = document.getElementById('toggle-prod-overlay');
  if (prodOverlayVisible) {
    btn.textContent  = '⬛ Masquer overlay';
    btn.className    = 'btn btn-danger';
  } else {
    btn.textContent  = '🟩 Afficher overlay';
    btn.className    = 'btn btn-ghost';
  }
});


let recapAutoEnabled = false;
document.getElementById('toggle-recap-overlay').addEventListener('click', () => {
  recapAutoEnabled = !recapAutoEnabled;
  ipcRenderer.send('toggle-recap-overlay', recapAutoEnabled);
  const btn = document.getElementById('toggle-recap-overlay');
  btn.textContent = recapAutoEnabled ? '📊 Recap automatique : ON' : '📊 Recap automatique : OFF';
  btn.className   = recapAutoEnabled ? 'btn btn-primary' : 'btn btn-ghost';
});

function applyManualSeries() {
  const blue   = parseInt(document.getElementById('manualSeriesBlue').value)   || 0;
  const orange = parseInt(document.getElementById('manualSeriesOrange').value) || 0;
  ipcRenderer.send('manual-series', { blue, orange });
}