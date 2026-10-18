const STORAGE_KEY = 'signal-scope-tab-v1';

export function readTabState(raw) {
  try {
    const value = JSON.parse(raw);
    return {tab:value?.tab === 'live' ? 'live' : 'record', lastRemoteActive:value?.lastRemoteActive === true};
  } catch { return {tab:'record',lastRemoteActive:false}; }
}

export function scopeTabTransition(state, event) {
  if (event.type === 'select' && ['record','live'].includes(event.tab)) return {...state,tab:event.tab};
  if (event.type === 'remote') {
    const remoteActive = event.active === true && event.owned === true;
    return {tab:remoteActive && !state.lastRemoteActive ? 'live' : state.tab,lastRemoteActive:remoteActive};
  }
  return state;
}

// Move the existing graph nodes; do not create another canvas, feed, or acquisition.
export function installScopeTabs({liveControls,partnerControls}) {
  const scope = document.getElementById('bench-view');
  const recording = scope?.querySelector('.bench-recording-panel');
  const graph = scope?.querySelector(':scope > .workspace');
  const diagnostics = scope?.querySelector(':scope > .bench-diagnostics');
  if (!scope || !recording || !graph) return null;
  let saved = null;
  try { saved = sessionStorage.getItem(STORAGE_KEY); } catch {}
  let state = readTabState(saved);
  const tabs = document.createElement('div');
  tabs.setAttribute('role','tablist');
  tabs.setAttribute('aria-label','Signal Scope mode');
  tabs.style.cssText = 'display:flex;gap:8px;margin:0 0 18px';
  const panels = {}, buttons = {}, graphSlots = {};
  for (const name of ['record','live']) {
    const button = document.createElement('button');
    button.id = `scope-tab-${name}`;
    button.type = 'button';
    button.textContent = name === 'record' ? 'Record' : 'Live';
    button.setAttribute('role','tab');
    button.setAttribute('aria-controls',`scope-panel-${name}`);
    tabs.append(button);
    buttons[name] = button;
    const panel = document.createElement('div');
    panel.id = `scope-panel-${name}`;
    panel.setAttribute('role','tabpanel');
    panel.setAttribute('aria-labelledby',button.id);
    panels[name] = panel;
    graphSlots[name] = document.createElement('div');
    graphSlots[name].dataset.graphSlot = name;
  }
  panels.record.append(recording, graphSlots.record);
  liveControls.style.marginBottom = '18px';
  partnerControls.style.marginTop = '18px';
  panels.live.append(liveControls, graphSlots.live, partnerControls);
  scope.prepend(tabs, panels.record, panels.live);

  function render() {
    graphSlots[state.tab].append(graph);
    if (diagnostics) graphSlots[state.tab].append(diagnostics);
    for (const name of ['record','live']) {
      const selected = state.tab === name;
      panels[name].hidden = !selected;
      buttons[name].setAttribute('aria-selected',String(selected));
      buttons[name].tabIndex = selected ? 0 : -1;
      buttons[name].className = `button ${selected ? 'primary' : 'secondary'}`;
    }
    scope.dataset.scopeTab = state.tab;
    // The existing renderer already redraws on resize, preserving its samples.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  function change(event) {
    const next = scopeTabTransition(state,event);
    const tabChanged = next.tab !== state.tab;
    const stateChanged = tabChanged || next.lastRemoteActive !== state.lastRemoteActive;
    state = next;
    if (stateChanged) {
      try { sessionStorage.setItem(STORAGE_KEY,JSON.stringify(state)); } catch {}
    }
    if (tabChanged) render();
  }
  for (const name of ['record','live']) {
    buttons[name].onclick = () => change({type:'select',tab:name});
    buttons[name].onkeydown = event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'record' : event.key === 'End' ? 'live' : name === 'record' ? 'live' : 'record';
      change({type:'select',tab:next});
      buttons[next].focus();
    };
  }
  render();
  return {observeRemote(value) { change({type:'remote',...value}); },getState() { return {...state}; }};
}
