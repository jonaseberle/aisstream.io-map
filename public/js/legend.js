import './settings.js'; // load saved UI settings before building controls below
import { map } from './map.js';
import { ships } from './state.js';
import { CATEGORIES, CATEGORY_TYPES, SHIP_TYPES } from './categories.js';
import { shapeSvgInner } from './icons.js';
import { filterState, hiddenCategories, hiddenTypes, applyVisibility, refreshTrail, MAX_AGE_SLIDER_MAX, MAX_LENGTH_SLIDER_MAX, MAX_INTERVAL_SLIDER_MAX, FLOATING_DISPLAY_SLIDER_MAX } from './visibility.js';
import { saveVesselData } from './storage.js';

// ── Legend ───────────────────────────────────────────────────────────────
const AisLegend = L.Control.extend({
  onAdd() {
    const div = L.DomUtil.create('div', 'ais-legend');
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    // ── Collapse header ──
    const hdr = document.createElement('div');
    hdr.className = 'legend-header';
    hdr.innerHTML = '<span>Filters</span><span class="legend-toggle">▲</span>';
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

    content.appendChild(mkCheckRow('filter-show-moving', 'Show moving (&gt;0.5 kts)', filterState.showMoving, (e) => {
      filterState.showMoving = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    content.appendChild(mkCheckRow('filter-show-nonmoving', 'Show non-moving', filterState.showNonMoving, (e) => {
      filterState.showNonMoving = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    content.appendChild(mkCheckRow('filter-spoofed', 'Hide unreliable/spoofed position', filterState.hideSpoofed, (e) => {
      filterState.hideSpoofed = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    content.appendChild(mkCheckRow('filter-hdg000', 'Hide unreliable heading/course', filterState.filterHdg000, (e) => {
      filterState.filterHdg000 = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    content.appendChild(mkCheckRow('filter-navstatus', 'Hide unreliable navStatus', filterState.hideUnreliableNavStatus, (e) => {
      filterState.hideUnreliableNavStatus = e.target.checked;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    }));
    content.appendChild(mkCheckRow('filter-show-fixes', 'Show AIS fixes', filterState.showFixes, (e) => {
      filterState.showFixes = e.target.checked;
      // Live mode adds/removes the fix circles here; smooth motion's loop
      // picks the change up on its next tick.
      for (const ship of ships.values()) refreshTrail(ship);
    }));


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
    content.appendChild(sliderRow);

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
    content.appendChild(leadRow);

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
    content.appendChild(minAgeRow);

    ageRow.innerHTML = `<label id="age-label">Max. age: ${filterState.maxAgeSec}s</label>
      <input type="range" id="age-slider" min="0" max="${MAX_AGE_SLIDER_MAX}" value="${filterState.maxAgeSec}">`;
    ageRow.querySelector('#age-slider').addEventListener('input', (e) => {
      filterState.maxAgeSec = parseInt(e.target.value, 10);
      document.getElementById('age-label').textContent =
        filterState.maxAgeSec >= MAX_AGE_SLIDER_MAX ? 'Max. age: off' : `Max. age: ${filterState.maxAgeSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    content.appendChild(ageRow);

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
    content.appendChild(floatingRow);

    const minIntervalRow = document.createElement('div');
    minIntervalRow.className = 'legend-slider';
    minIntervalRow.innerHTML = `<label id="min-interval-label">Min. interval (moving vessels): ${filterState.minIntervalSec}s</label>
      <input type="range" id="min-interval-slider" min="0" max="${MAX_INTERVAL_SLIDER_MAX}" step="5" value="${filterState.minIntervalSec}">`;
    minIntervalRow.querySelector('#min-interval-slider').addEventListener('input', (e) => {
      filterState.minIntervalSec = parseInt(e.target.value, 10);
      document.getElementById('min-interval-label').textContent = `Min. interval (moving vessels): ${filterState.minIntervalSec}s`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    content.appendChild(minIntervalRow);

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
    content.appendChild(maxIntervalRow);

    const minLengthRow = document.createElement('div');
    minLengthRow.className = 'legend-slider';
    minLengthRow.innerHTML = `<label id="min-length-label">Min. length: ${filterState.minLengthM}m</label>
      <input type="range" id="min-length-slider" min="0" max="400" step="5" value="${filterState.minLengthM}">`;
    minLengthRow.querySelector('#min-length-slider').addEventListener('input', (e) => {
      filterState.minLengthM = parseInt(e.target.value, 10);
      document.getElementById('min-length-label').textContent = `Min. length: ${filterState.minLengthM}m`;
      for (const mmsi of ships.keys()) applyVisibility(mmsi);
    });
    content.appendChild(minLengthRow);

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
    content.appendChild(maxLengthRow);

    const sep = document.createElement('div');
    sep.className = 'legend-sep';
    content.appendChild(sep);

    const title = document.createElement('div');
    title.className = 'legend-title';
    title.textContent = 'Ship types';
    content.appendChild(title);

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

      content.appendChild(catRow);
      if (types.length > 0) content.appendChild(subContainer);
    }

    const hint = document.createElement('div');
    hint.id = 'dim-hint';
    hint.className = 'legend-hint legend-hint--dim';
    hint.textContent = 'Zoom in to show vessel dimensions';
    content.appendChild(hint);

    const speedHint = document.createElement('div');
    speedHint.id = 'speed-hint';
    speedHint.className = 'legend-hint';
    speedHint.textContent = 'Each white dot ahead of the bow = 1 knot of speed';
    content.appendChild(speedHint);

    return div;
  },
});

new AisLegend({ position: 'bottomright' }).addTo(map);
