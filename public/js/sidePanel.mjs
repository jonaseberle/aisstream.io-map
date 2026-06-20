// Shared fly-in container on the right edge of the screen, holding the
// Settings and AIS Fixes panels as tabs instead of two separate panels that
// would otherwise stack exactly on top of each other (both full-height,
// same edge). Self-builds its DOM as a side effect of being imported (same
// pattern legend.mjs used to use for the old standalone settings panel), so
// it's ready before any importer's own top-level code (e.g. legend.mjs
// registering the Settings tab) runs.
let flyinEl = null;
let tabBarEl = null;
let bodyEl = null;
let reopenTabEl = null;
let open = true;
let activeTab = null;
const tabs = new Map(); // id -> { label, contentEl, closable, visible }

function renderTabBar() {
  tabBarEl.innerHTML = '';
  for (const [id, tab] of tabs) {
    if (!tab.visible) continue;
    const tabEl = document.createElement('div');
    tabEl.className = 'side-tab' + (id === activeTab ? ' active' : '');
    tabEl.addEventListener('click', () => selectTab(id));
    const labelEl = document.createElement('span');
    labelEl.className = 'side-tab-label';
    labelEl.textContent = tab.label;
    tabEl.appendChild(labelEl);
    if (tab.closable) {
      const closeEl = document.createElement('button');
      closeEl.type = 'button';
      closeEl.className = 'side-tab-close';
      closeEl.textContent = '✕';
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also select this tab right before hiding it
        setTabVisible(id, false);
      });
      tabEl.appendChild(closeEl);
    }
    tabBarEl.appendChild(tabEl);
  }
}

function renderBody() {
  bodyEl.innerHTML = '';
  const tab = activeTab ? tabs.get(activeTab) : null;
  if (tab) bodyEl.appendChild(tab.contentEl);
}

export function isTabActive(id) {
  return activeTab === id;
}

export function selectTab(id) {
  if (!tabs.has(id) || !tabs.get(id).visible) return;
  activeTab = id;
  renderTabBar();
  renderBody();
}

// Registers a tab once (called by legend.mjs for 'settings', fixesPanel.mjs
// for 'fixes'). `visible: false` lets a tab exist but stay out of the tab
// bar until something explicitly shows it (setTabVisible) — used for AIS
// Fixes, which has nothing to display until a vessel's been clicked.
export function registerTab(id, label, contentEl, { closable = false, visible = true, onHide = null } = {}) {
  tabs.set(id, { label, contentEl, closable, visible, onHide });
  if (visible && !activeTab) activeTab = id;
  renderTabBar();
  renderBody();
}

// Shows/hides a tab in the bar without unregistering it. Hiding the active
// tab falls back to any other visible tab (preferring 'settings', since
// it's the one tab guaranteed to always exist). Fires the tab's onHide
// (from registerTab) whenever it transitions visible → hidden, regardless
// of whether that came from the tab bar's own close button or elsewhere.
export function setTabVisible(id, visible) {
  const tab = tabs.get(id);
  if (!tab) return;
  const wasVisible = tab.visible;
  tab.visible = visible;
  if (wasVisible && !visible && tab.onHide) tab.onHide();
  if (!visible && activeTab === id) {
    activeTab = tabs.has('settings') && tabs.get('settings').visible
      ? 'settings'
      : [...tabs.keys()].find((k) => tabs.get(k).visible) ?? null;
    renderBody();
  } else if (visible && !activeTab) {
    activeTab = id;
    renderBody();
  }
  renderTabBar();
}

function setOpen(next) {
  open = next;
  flyinEl.classList.toggle('open', open);
  reopenTabEl.classList.toggle('visible', !open);
}

// Opens the panel and, if given, switches straight to that tab — used by
// the popup's "AIS Fixes ›" button so clicking it both reveals the tab and
// brings the whole panel into view in one step.
export function openSidePanel(id) {
  if (id) selectTab(id);
  setOpen(true);
}

flyinEl = document.createElement('div');
flyinEl.id = 'side-flyin';
flyinEl.className = 'side-flyin open';
flyinEl.innerHTML = `
  <div class="side-flyin-header">
    <div class="side-tab-bar"></div>
    <button type="button" class="side-flyin-min" title="Minimize">›</button>
  </div>
  <div class="side-flyin-body"></div>`;
document.body.appendChild(flyinEl);
tabBarEl = flyinEl.querySelector('.side-tab-bar');
bodyEl = flyinEl.querySelector('.side-flyin-body');
flyinEl.querySelector('.side-flyin-min').addEventListener('click', () => setOpen(false));

reopenTabEl = document.createElement('button');
reopenTabEl.type = 'button';
reopenTabEl.id = 'side-flyin-reopen';
reopenTabEl.className = 'side-flyin-reopen';
reopenTabEl.textContent = '‹';
reopenTabEl.addEventListener('click', () => setOpen(true));
document.body.appendChild(reopenTabEl);
