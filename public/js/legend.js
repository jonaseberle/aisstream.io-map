import './settings.js'; // load saved UI settings before building controls below
import { map, MAP_SOURCES, setMapSource } from './map.js';
import { ships } from './state.js';
import { CATEGORIES, CATEGORY_TYPES, SHIP_TYPES } from './categories.js';
import { shapeSvgInner } from './icons.js';
import { filterState, hiddenCategories, hiddenTypes, applyVisibility, refreshTrail, MAX_AGE_SLIDER_MAX, MAX_LENGTH_SLIDER_MAX, MAX_INTERVAL_SLIDER_MAX, FLOATING_DISPLAY_SLIDER_MAX } from './visibility.js';
import { saveVesselData } from './storage.js';
import { updateLabel, refreshIcon } from './messages.js';
import { saveSettings } from './settings.js';

// ── Legend ───────────────────────────────────────────────────────────────
const AisLegend = L.Control.extend({
  onAdd() {
    const div = L.DomUtil.create('div', 'ais-legend');
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    // ── Collapse header ── (also hosts the connection status, relocated
    // from the old page header — same ids, so websocket.js's
    // getElementById('status-dot'/'status-text') and stats.js's msg-rate
    // keep working unchanged.)
    const hdr = document.createElement('div');
    hdr.className = 'legend-header';
    hdr.innerHTML = `<span class="legend-header-left">
        <span id="status-dot" style="display: inline-block"></span>
        <span id="status-text">Connecting…</span>
        <span id="msg-rate-wrap">(<strong id="msg-rate">0</strong> msg/s)</span>
        <span></span>
      </span><span class="legend-toggle">▲</span>`;
    div.appendChild(hdr);

    const content = document.createElement('div');
    content.className = 'legend-content';
    div.appendChild(content);

    hdr.addEventListener('click', () => {
      const open = !content.classList.contains('collapsed');
      content.classList.toggle('collapsed', open);
      hdr.querySelector('.legend-toggle').textContent = open ? '▼' : '▲';
    });

    // ── Global filters ──
    function mkCheckRow(id, label, checked, onChange) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<input type="checkbox" id="${id}"${checked ? ' checked' : ''}>
        <label for="${id}">${label}</label>`;
      row.querySelector('input').addEventListener('change', onChange);
      return row;
    }
    function mkRadioRow(name, id, label, checked, onChange) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<input type="radio" name="${name}" id="${id}"${checked ? ' checked' : ''}>
        <label for="${id}">${label}</label>`;
      row.querySelector('input').addEventListener('change', onChange);
      return row;
    }
    // Wraps a <input type=range> with "‹"/"›" buttons that nudge it by one
    // step — applied to every slider in the panel in one pass, at the end
    // (see the loop near `return div`), rather than per-slider, so it
    // automatically covers any slider added above without extra boilerplate.
    function addSteppers(slider) {
      const step = parseFloat(slider.step) || 1;
      const decimals = (String(step).split('.')[1] || '').length;
      const bump = (delta) => {
        const min = parseFloat(slider.min), max = parseFloat(slider.max);
        const v = Math.min(max, Math.max(min, parseFloat(slider.value) + delta));
        slider.value = decimals ? v.toFixed(decimals) : v;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const mkBtn = (symbol, delta) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'legend-step-btn';
        btn.textContent = symbol;
        btn.addEventListener('click', () => bump(delta));
        return btn;
      };
      slider.insertAdjacentElement('beforebegin', mkBtn('‹', -step));
      slider.insertAdjacentElement('afterend', mkBtn('›', step));
    }

    // A titled, independently foldable group — fold state persists in
    // filterState[key] (saved like any other filter, via the cookie).
    // Appends both the title and its body to `content` and returns the
    // body so callers can append their rows/sliders into it.
    function mkGroup(label, key) {
      const titleRow = document.createElement('div');
      titleRow.className = 'legend-title legend-group-title';
      titleRow.innerHTML = `<span>${label}</span><span class="legend-toggle">${filterState[key] ? '▶' : '▼'}</span>`;
      const body = document.createElement('div');
      body.className = 'legend-group-body';
      if (filterState[key]) body.classList.add('collapsed');
      titleRow.addEventListener('click', () => {
        filterState[key] = !filterState[key];
        body.classList.toggle('collapsed', filterState[key]);
        titleRow.querySelector('.legend-toggle').textContent = filterState[key] ? '▶' : '▼';
        saveSettings();
      });
      content.appendChild(titleRow);
      content.appendChild(body);
      return body;
    }

    const smoothMotionBody = mkGroup('Smooth Motion', 'smoothMotionCollapsed');

    const smRow = document.createElement('div');
    smRow.className = 'legend-row';
    smRow.innerHTML = `<label id="smooth-motion-label"><input type="checkbox" id="smooth-motion-checkbox"> Smooth motion</label>`;
    smoothMotionBody.appendChild(smRow);

    const smSliderRow = document.createElement('div');
    smSliderRow.className = 'legend-slider';
    smSliderRow.innerHTML = `<label id="smooth-motion-delta-label" title="How far in the past, in seconds, smooth motion displays vessel positions — trades immediacy for a smoother, more accurate interpolation between AIS reports.">Delta(s): 300</label>
      <input type="range" id="smooth-motion-slider" min="60" max="3000" step="10" value="300">`;
    smoothMotionBody.appendChild(smSliderRow);

    // initSmoothMotionControls() (called from main.js, after legend.js builds
    // this panel) attaches the real listeners to the elements above — same
    // ids as before, just relocated from the header into this group.

    const tensionRow = document.createElement('div');
    tensionRow.className = 'legend-slider';
    tensionRow.innerHTML = `<label id="tension-label" title="How much the smooth-motion path bulges toward each fix's reported course vs. hugging the straight line between fixes.">Tension: ${filterState.smoothMotionTension.toFixed(2)}</label>
      <input type="range" id="tension-slider" min="0" max="1" step="0.05" value="${filterState.smoothMotionTension}">`;
    tensionRow.querySelector('#tension-slider').addEventListener('input', (e) => {
      filterState.smoothMotionTension = parseFloat(e.target.value);
      document.getElementById('tension-label').textContent = `Tension: ${filterState.smoothMotionTension.toFixed(2)}`;
    });
    smoothMotionBody.appendChild(tensionRow);

    const minIntervalRow = document.createElement('div');
    minIntervalRow.className = 'legend-slider';
    minIntervalRow.innerHTML = `<label id="min-interval-label">Min. interval (moving vessels): ${filterState.minIntervalSec}s</label>
      <input type="range" id="min-interval-slider" min="0" max="${MAX_INTERVAL_SLIDER_MAX}" step="5" value="${filterState.minIntervalSec}">`;
    minIntervalRow.querySelector('#min-interval-slider').addEventListener('input', (e) => {
      filterState.minIntervalSec = parseInt(e.target.value, 10);
      document.getElementById('min-interval-label').textContent = `Min. interval (moving vessels): ${filterState.minIntervalSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    smoothMotionBody.appendChild(minIntervalRow);

    const maxIntervalRow = document.createElement('div');
    maxIntervalRow.className = 'legend-slider';
    maxIntervalRow.innerHTML = `<label id="max-interval-label">Max. interval (moving vessels): ${filterState.maxIntervalSec >= MAX_INTERVAL_SLIDER_MAX ? 'off' : filterState.maxIntervalSec + 's'}</label>
      <input type="range" id="max-interval-slider" min="0" max="${MAX_INTERVAL_SLIDER_MAX}" step="5" value="${filterState.maxIntervalSec}">`;
    maxIntervalRow.querySelector('#max-interval-slider').addEventListener('input', (e) => {
      filterState.maxIntervalSec = parseInt(e.target.value, 10);
      document.getElementById('max-interval-label').textContent = filterState.maxIntervalSec >= MAX_INTERVAL_SLIDER_MAX
        ? 'Max. interval (moving vessels): off'
        : `Max. interval (moving vessels): ${filterState.maxIntervalSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    smoothMotionBody.appendChild(maxIntervalRow);

    const smSep = document.createElement('div');
    smSep.className = 'legend-sep';
    content.appendChild(smSep);

    const boundsBody = mkGroup('Bounds', 'boundsCollapsed');

    const fbRow = document.createElement('div');
    fbRow.className = 'legend-row';
    fbRow.innerHTML = `<label id="freeze-bounds-label" title="Stop updating the dashed bounding-box outline on the map."><input type="checkbox" id="freeze-bounds-checkbox"> Freeze bounds rect</label>`;
    boundsBody.appendChild(fbRow);
    // initBoundsRectControls() (called from main.js via initWebSocket(),
    // after legend.js builds this panel) attaches the real listener — same
    // id as before, just relocated from the header into this group.

    const boundsSep = document.createElement('div');
    boundsSep.className = 'legend-sep';
    content.appendChild(boundsSep);

    const displayBody = mkGroup('Display', 'displayCollapsed');

    displayBody.appendChild(mkCheckRow('filter-show-fixes', 'Show AIS fixes', filterState.showFixes, (e) => {
      filterState.showFixes = e.target.checked;
      // Live mode adds/removes the fix circles here; smooth motion's loop
      // picks the change up on its next tick.
      for (const ship of ships.values()) refreshTrail(ship);
    }));
    displayBody.appendChild(mkCheckRow('filter-show-labels', 'Show ship name labels', filterState.showLabels, (e) => {
      filterState.showLabels = e.target.checked;
      for (const mmsi of ships.keys()) updateLabel(mmsi);
    }));
    displayBody.appendChild(mkCheckRow('filter-show-antenna', 'Show GPS antenna position', filterState.showAntenna, (e) => {
      filterState.showAntenna = e.target.checked;
      // Force a redraw even under smooth motion, where the loop only
      // redraws on a heading change — this toggle doesn't change heading.
      for (const [mmsi, ship] of ships) { refreshIcon(mmsi); ship.smoothIconHeading = null; }
    }));

    const speedHint = document.createElement('div');
    speedHint.id = 'speed-hint';
    speedHint.className = 'legend-hint';
    speedHint.textContent = 'Each white dot ahead of the bow = 1 knot of speed';
    displayBody.appendChild(speedHint);

    const mapSourceTitle = document.createElement('div');
    mapSourceTitle.className = 'legend-hint';
    mapSourceTitle.style.marginTop = '8px';
    mapSourceTitle.textContent = 'Map style:';
    displayBody.appendChild(mapSourceTitle);

    // Applies the cookie-restored choice right away — map.js itself only
    // knows the hardcoded 'dark' default, since it stays filterState-free
    // to avoid a map.js <-> visibility.js import cycle.
    setMapSource(filterState.mapSource);
    for (const [key, label] of Object.entries(MAP_SOURCES)) {
      displayBody.appendChild(mkRadioRow('map-source', `map-source-${key}`, label, filterState.mapSource === key, (e) => {
        if (!e.target.checked) return;
        filterState.mapSource = key;
        setMapSource(key);
      }));
    }

    const sliderRow = document.createElement('div');
    sliderRow.className = 'legend-slider';
    sliderRow.innerHTML = `<label id="trail-label">Trail: ${filterState.trailSec === 0 ? 'off' : filterState.trailSec + 's'}</label>
      <input type="range" id="trail-slider" min="0" max="7200" step="30" value="${filterState.trailSec}">`;
    sliderRow.querySelector('#trail-slider').addEventListener('input', (e) => {
      filterState.trailSec = parseInt(e.target.value, 10);
      document.getElementById('trail-label').textContent =
        filterState.trailSec === 0 ? 'Trail: off' : `Trail: ${filterState.trailSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
      for (const ship of ships.values()) refreshTrail(ship);
    });
    displayBody.appendChild(sliderRow);

    // Lead line: how far AHEAD to project the smooth-motion track. Only has a
    // visible effect while smooth motion is on (the smooth-motion loop reads
    // filterState.leadSec each tick), so no applyVisibility call is needed here.
    const leadRow = document.createElement('div');
    leadRow.className = 'legend-slider';
    leadRow.innerHTML = `<label id="lead-label">Lead: ${filterState.leadSec === 0 ? 'off' : filterState.leadSec + 's'}</label>
      <input type="range" id="lead-slider" min="0" max="1200" step="30" value="${filterState.leadSec}">`;
    leadRow.querySelector('#lead-slider').addEventListener('input', (e) => {
      filterState.leadSec = parseInt(e.target.value, 10);
      document.getElementById('lead-label').textContent =
        filterState.leadSec === 0 ? 'Lead: off' : `Lead: ${filterState.leadSec}s`;
    });
    displayBody.appendChild(leadRow);

    const displaySep = document.createElement('div');
    displaySep.className = 'legend-sep';
    content.appendChild(displaySep);

    const filtersBody = mkGroup('Filters', 'filtersCollapsed');

    filtersBody.appendChild(mkCheckRow('filter-show-moving', 'Show moving (&gt;0.5 kts)', filterState.showMoving, (e) => {
      filterState.showMoving = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    filtersBody.appendChild(mkCheckRow('filter-show-nonmoving', 'Show non-moving', filterState.showNonMoving, (e) => {
      filterState.showNonMoving = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    filtersBody.appendChild(mkCheckRow('filter-spoofed', 'Hide unreliable/spoofed position', filterState.hideSpoofed, (e) => {
      filterState.hideSpoofed = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    filtersBody.appendChild(mkCheckRow('filter-hdg000', 'Hide unreliable heading/course', filterState.filterHdg000, (e) => {
      filterState.filterHdg000 = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    filtersBody.appendChild(mkCheckRow('filter-navstatus', 'Hide unreliable navStatus', filterState.hideUnreliableNavStatus, (e) => {
      filterState.hideUnreliableNavStatus = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));

    const ageRow = document.createElement('div');
    ageRow.className = 'legend-slider';
    const minAgeRow = document.createElement('div');
    minAgeRow.className = 'legend-slider';
    minAgeRow.innerHTML = `<label id="min-age-label">Min. age: ${filterState.minAgeSec}s</label>
      <input type="range" id="min-age-slider" min="0" max="600" value="${filterState.minAgeSec}">`;
    minAgeRow.querySelector('#min-age-slider').addEventListener('input', (e) => {
      filterState.minAgeSec = parseInt(e.target.value, 10);
      document.getElementById('min-age-label').textContent = `Min. age: ${filterState.minAgeSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    filtersBody.appendChild(minAgeRow);

    ageRow.innerHTML = `<label id="age-label">Max. age: ${filterState.maxAgeSec}s</label>
      <input type="range" id="age-slider" min="0" max="${MAX_AGE_SLIDER_MAX}" value="${filterState.maxAgeSec}">`;
    ageRow.querySelector('#age-slider').addEventListener('input', (e) => {
      filterState.maxAgeSec = parseInt(e.target.value, 10);
      document.getElementById('age-label').textContent =
        filterState.maxAgeSec >= MAX_AGE_SLIDER_MAX ? 'Max. age: off' : `Max. age: ${filterState.maxAgeSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    filtersBody.appendChild(ageRow);

    const floatingRow = document.createElement('div');
    floatingRow.className = 'legend-slider';
    floatingRow.innerHTML = `<label id="floating-label">Show floating targets for: ${filterState.floatingDisplaySec}s</label>
      <input type="range" id="floating-slider" min="0" max="${FLOATING_DISPLAY_SLIDER_MAX}" step="30" value="${filterState.floatingDisplaySec}">`;
    floatingRow.querySelector('#floating-slider').addEventListener('input', (e) => {
      filterState.floatingDisplaySec = parseInt(e.target.value, 10);
      document.getElementById('floating-label').textContent = filterState.floatingDisplaySec >= FLOATING_DISPLAY_SLIDER_MAX
        ? 'Show floating targets for: always'
        : `Show floating targets for: ${filterState.floatingDisplaySec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    filtersBody.appendChild(floatingRow);

    const minLengthRow = document.createElement('div');
    minLengthRow.className = 'legend-slider';
    minLengthRow.innerHTML = `<label id="min-length-label">Min. length: ${filterState.minLengthM}m</label>
      <input type="range" id="min-length-slider" min="0" max="400" step="5" value="${filterState.minLengthM}">`;
    minLengthRow.querySelector('#min-length-slider').addEventListener('input', (e) => {
      filterState.minLengthM = parseInt(e.target.value, 10);
      document.getElementById('min-length-label').textContent = `Min. length: ${filterState.minLengthM}m`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    filtersBody.appendChild(minLengthRow);

    const maxLengthRow = document.createElement('div');
    maxLengthRow.className = 'legend-slider';
    maxLengthRow.innerHTML = `<label id="max-length-label">Max. length: ${filterState.maxLengthM >= MAX_LENGTH_SLIDER_MAX ? 'off' : filterState.maxLengthM + 'm'}</label>
      <input type="range" id="max-length-slider" min="0" max="${MAX_LENGTH_SLIDER_MAX}" step="5" value="${filterState.maxLengthM}">`;
    maxLengthRow.querySelector('#max-length-slider').addEventListener('input', (e) => {
      filterState.maxLengthM = parseInt(e.target.value, 10);
      document.getElementById('max-length-label').textContent =
        filterState.maxLengthM >= MAX_LENGTH_SLIDER_MAX ? 'Max. length: off' : `Max. length: ${filterState.maxLengthM}m`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    filtersBody.appendChild(maxLengthRow);

    const sep = document.createElement('div');
    sep.className = 'legend-sep';
    content.appendChild(sep);

    const shipTypesBody = mkGroup('Ship types', 'shipTypesCollapsed');

    // ── Per-category with collapsible sub-types ──
    for (const [cat, { color, label }] of Object.entries(CATEGORIES)) {
      const inner = shapeSvgInner(cat, color, 0);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20" viewBox="0 0 16 20">${inner}</svg>`;
      const id = `cat-${cat}`;
      const types = CATEGORY_TYPES[cat] || [];

      const catRow = document.createElement('div');
      const catInitiallyOn = !hiddenCategories.has(cat);
      catRow.className = 'legend-row' + (catInitiallyOn ? '' : ' dimmed');
      catRow.innerHTML = `<input type="checkbox" id="${id}" data-cat="${cat}"${catInitiallyOn ? ' checked' : ''}>${svg}
        <label for="${id}">${label}</label>`;

      const subContainer = document.createElement('div');
      subContainer.className = 'legend-subcontainer';
      const catCheckbox = catRow.querySelector('input');
      const subCheckboxes = [];

      // Reflect the combined state of all sub-type checkboxes on the category
      // checkbox: fully checked/unchecked, or indeterminate ("half-checked")
      // when only some sub-types are active.
      function syncCatCheckboxFromSubtypes() {
        const checkedCount = subCheckboxes.filter((cb) => cb.checked).length;
        if (checkedCount === subCheckboxes.length) {
          catCheckbox.checked = true;
          catCheckbox.indeterminate = false;
          hiddenCategories.delete(cat);
          catRow.classList.remove('dimmed');
        } else if (checkedCount === 0) {
          catCheckbox.checked = false;
          catCheckbox.indeterminate = false;
          hiddenCategories.add(cat);
          catRow.classList.add('dimmed');
        } else {
          catCheckbox.checked = false;
          catCheckbox.indeterminate = true;
          hiddenCategories.delete(cat); // partial: let per-type hiddenTypes govern visibility
          catRow.classList.remove('dimmed');
        }
      }

      if (types.length > 0) {
        const drill = document.createElement('span');
        drill.className = 'legend-drill';
        drill.textContent = '▶';
        drill.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = subContainer.classList.contains('open');
          subContainer.classList.toggle('open', !open);
          drill.textContent = open ? '▶' : '▼';
        });
        catRow.appendChild(drill);

        for (const typeCode of types) {
          const typeLabel = SHIP_TYPES[typeCode] ?? `Type ${typeCode}`;
          const subId = `type-${typeCode}`;
          const subInitiallyOn = !hiddenTypes.has(typeCode);
          const subRow = document.createElement('div');
          subRow.className = 'legend-subrow' + (subInitiallyOn ? '' : ' dimmed');
          subRow.innerHTML = `<input type="checkbox" id="${subId}" data-type="${typeCode}"${subInitiallyOn ? ' checked' : ''}>
            <label for="${subId}">${typeCode} – ${typeLabel}</label>`;
          const subCheckbox = subRow.querySelector('input');
          subCheckbox.addEventListener('change', (e) => {
            const tc = parseInt(e.target.dataset.type, 10);
            if (e.target.checked) hiddenTypes.delete(tc);
            else hiddenTypes.add(tc);
            subRow.classList.toggle('dimmed', !e.target.checked);
            syncCatCheckboxFromSubtypes();
            for (const mmsi of ships.keys()) applyVisibility(mmsi);
          });
          subCheckboxes.push(subCheckbox);
          subContainer.appendChild(subRow);
        }
        // Reflect a restored partial selection (some but not all sub-types
        // hidden) on the category checkbox right away, as indeterminate.
        syncCatCheckboxFromSubtypes();
      }

      catCheckbox.addEventListener('change', (e) => {
        const c = e.target.dataset.cat;
        const checked = e.target.checked;
        e.target.indeterminate = false; // user made an explicit all-on/all-off choice
        if (checked) hiddenCategories.delete(c);
        else hiddenCategories.add(c);
        catRow.classList.toggle('dimmed', !checked);
        subContainer.classList.toggle('cat-dimmed', !checked);

        // Cascade to all sub-type checkboxes so they match the category state.
        for (const cb of subCheckboxes) {
          cb.checked = checked;
          const tc = parseInt(cb.dataset.type, 10);
          if (checked) hiddenTypes.delete(tc);
          else hiddenTypes.add(tc);
          cb.closest('.legend-subrow').classList.toggle('dimmed', !checked);
        }

        for (const mmsi of ships.keys()) applyVisibility(mmsi);
      });

      shipTypesBody.appendChild(catRow);
      if (types.length > 0) shipTypesBody.appendChild(subContainer);
    }

    const shipTypesSep = document.createElement('div');
    shipTypesSep.className = 'legend-sep';
    content.appendChild(shipTypesSep);

    const debugBody = mkGroup('Debug', 'debugCollapsed');

    const statsRow = document.createElement('div');
    statsRow.className = 'legend-row';
    statsRow.innerHTML = `<span>Ships: <strong id="ship-count">0</strong></span>`;
    debugBody.appendChild(statsRow);

    const movingRow = document.createElement('div');
    movingRow.className = 'legend-row';
    movingRow.innerHTML = `<span>Moving: <strong id="moving-count">0</strong></span>`;
    debugBody.appendChild(movingRow);

    const singleObsRow = document.createElement('div');
    singleObsRow.className = 'legend-row';
    singleObsRow.innerHTML = `<span>Single obs.: <strong id="single-obs-count">0</strong></span>`;
    debugBody.appendChild(singleObsRow);

    const intervalRow = document.createElement('div');
    intervalRow.className = 'legend-row';
    intervalRow.innerHTML = `<span>Last update interval (moving vessels): <br><strong id="avg-interval" title="p50 and p80 are percentiles: 50% (resp. 80%) of samples are at or below this value.">—</strong></span>`;
    debugBody.appendChild(intervalRow);

    const resetSep = document.createElement('div');
    resetSep.className = 'legend-sep';
    content.appendChild(resetSep);

    const resetButton = document.createElement('button');
    resetButton.id = 'reset-settings-button';
    resetButton.className = 'legend-button';
    resetButton.title = 'Reset settings';
    resetButton.textContent = 'Reset settings';
    content.appendChild(resetButton);
    // main.js attaches the real click handler — same id as before, just
    // relocated from the header into the settings panel itself.

    // Persist every filter/category/type change immediately, rather than
    // waiting for main.js's periodic save — catches changes made right
    // before a reload/close.
    content.addEventListener('change', () => saveSettings());
    content.addEventListener('input', () => saveSettings());

    for (const slider of content.querySelectorAll('input[type=range]')) addSteppers(slider);

    return div;
  },
});

new AisLegend({ position: 'bottomright' }).addTo(map);
