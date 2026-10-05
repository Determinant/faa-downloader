/* global L */
'use strict';
const $ = id => document.getElementById(id);
const presets = {
  valley: { center: [36.42, -119.80], zoom: 12 },
  yuma: { center: [32.72, -114.62], zoom: 12 },
  texas: { center: [33.5, -97.25], zoom: 11 },
  bay: { center: [37.88, -122.05], zoom: 12 },
  la: { center: [34.18, -118.48], zoom: 12 },
  keywest: { center: [24.556, -81.766], zoom: 14 },
  overview: { center: [37.5, -98], zoom: 5 },
};
const colors = { 1: '#c0a1ff', 2: '#8fdf79' };
const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 4, maxZoom: 18,
  maxBounds: [[22, -129], [52, -64]], maxBoundsViscosity: 0.8 }).setView(presets.overview.center, presets.overview.zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: true, metric: false, maxWidth: 120 }).addTo(map);
const imagery = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18, attribution: 'Imagery © Esri, Vantor, Earthstar Geographics, GIS User Community', crossOrigin: true }).addTo(map);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', crossOrigin: true });
map.createPane('coverage').style.zIndex = 390;
map.createPane('candidates').style.zIndex = 420;
map.createPane('selection').style.zIndex = 430;
map.getPane('selection').style.pointerEvents = 'none';
const source = { version: 1, sample: '' };
let hidden = false, controller, sequence = 0, timer;
let lastData, downloadedUrl, selectedId, selectedTier;
// One canvas lets clicks reach either tier, without an upper canvas intercepting the lower tier.
const renderer = L.canvas({ pane: 'candidates', padding: 0.5 });
const selected = L.geoJSON([], { pane: 'selection', interactive: false, style: { color: '#fff', weight: 2, fill: false } }).addTo(map);
const coverage = L.layerGroup().addTo(map);
const layers = {};
for (const tier of [1, 2]) layers[tier] = L.geoJSON([], {
  pane: 'candidates', renderer,
  // Apply opacity once to the combined pane so overlapping polygons do not darken.
  style: { fillColor: colors[tier], fillOpacity: 1, stroke: false },
  onEachFeature: (feature, layer) => {
    layer.bindTooltip(`${tier === 2 ? 'Preferred' : 'Best effort'} · ${feature.properties.lengthFt.toLocaleString()} ft fit`, { sticky: true });
    layer.on('click', () => inspect(feature));
  },
}).addTo(map);

function element(tag, text, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function inspect(feature) {
  selectedId = feature.id; selectedTier = feature.properties.tier;
  selected.clearLayers().addData(feature);
  const p = feature.properties, box = $('details');
  const heading = element('h2', p.tier === 2 ? 'Preferred area' : 'Best-effort area');
  heading.style.color = colors[p.tier];
  const stats = document.createElement('dl'); stats.className = 'detail-stats';
  for (const [label, value] of [['Qualifying length', `${p.lengthFt.toLocaleString()} ft`], ['Screened width', `${p.widthFt} ft`],
    ['Max fit elevation', `${Math.ceil(p.elevationM * 3.28084).toLocaleString()} ft MSL`],
    ...(Number.isFinite(p.alongGradePercent) ? [['Approx. overall grade', `${Math.abs(p.alongGradePercent).toFixed(1)}% along · ${Math.abs(p.crossGradePercent).toFixed(1)}% across`]] : [])]) {
    const item = document.createElement('div'); item.append(element('dt', label), element('dd', value)); stats.append(item);
  }
  const flags = document.createElement('div'); flags.className = 'flags';
  for (const [bit, label] of [[1, 'Crop condition unverified'], [2, 'Shrub surface unverified'], [4, 'Broader shrub allowance'], [8, 'Canopy models disagree'], [16, 'Sloped/uneven ground'], [32, 'Developed open space'], [64, 'Reduced building setback'], [128, 'Bare/mixed open surface unverified'], [256, 'Constrained fit or ground clearance'], [512, 'Reduced obstacle exclusion'], [1024, 'Opening corroborated despite conflicting cover classifications']]) {
    if (p.flags & bit) flags.append(element('span', label, 'flag'));
  }
  if (!flags.childNodes.length) flags.append(element('span', 'No additional surface flags', 'flag'));
  box.replaceChildren(element('p', 'Selected candidate', 'label section-label'), heading, stats, flags);
}
function applyLayers() {
  map.getPane('candidates').style.opacity = Number($('opacity').value) / 100;
  for (const tier of [1, 2]) {
    const visible = !hidden && $(tier === 2 ? 'preferred' : 'emergency').checked;
    if (visible && !map.hasLayer(layers[tier])) layers[tier].addTo(map);
    else if (!visible && map.hasLayer(layers[tier])) map.removeLayer(layers[tier]);
  }
  if (map.hasLayer(layers[2])) layers[2].bringToFront();
  map.getPane('selection').style.display = hidden || selectedTier && !$(selectedTier === 2 ? 'preferred' : 'emergency').checked ? 'none' : '';
  $('opacity-value').value = `${$('opacity').value}%`;
  $('compare').textContent = hidden ? 'Show candidate areas' : 'Hide areas to compare';
  $('compare').setAttribute('aria-pressed', String(hidden));
}
function showCoverage() {
  coverage.clearLayers();
  if (!lastData || lastData.meta.source === 'sample' || !$('grid').checked && lastData.meta.mode !== 'overview') return;
  const overview = lastData.meta.mode === 'overview';
  for (const item of lastData.coverage) {
    const [w, s, e, n] = item.bounds;
    const layer = L.rectangle([[s, w], [n, e]], { pane: 'coverage', color: '#75b9f5', weight: 1,
      opacity: overview ? 0.5 : 0.6, fillOpacity: overview ? 0.14 : 0.035, dashArray: overview ? null : '3 5' });
    layer.bindTooltip(overview ? `${item.count} saved chunks · click to explore` : 'Saved analysis exists in this chunk');
    if (overview) layer.on('click', () => map.setView([(s + n) / 2, (w + e) / 2], 10));
    coverage.addLayer(layer);
  }
}
function render(data) {
  lastData = data;
  for (const tier of [1, 2]) layers[tier].clearLayers().addData({ type: 'FeatureCollection', features: data.features.filter(f => f.properties.tier === tier) });
  selected.clearLayers();
  const selection = data.features.find(feature => feature.id === selectedId);
  if (selection) inspect(selection);
  else if (selectedId) {
    selectedId = selectedTier = undefined;
    $('details').replaceChildren(element('p', 'Inspect an area', 'label section-label'),
      element('p', 'Click a colored patch to see its qualifying length and surface flags.', 'detail-hint'));
  }
  showCoverage(); applyLayers();
  $('source-label').textContent = data.meta.source === 'sample' ? 'Saved sample' : data.meta.version === data.meta.currentVersion ? 'Live build' : 'Previous build';
  $('preferred-length').textContent = data.meta.labels.preferred;
  $('fallback-length').textContent = data.meta.labels.fallback;
  source.version = data.meta.version;
  $('analysis-version').value = String(source.version);
  saveLocation();
  $('version').textContent = `v${data.meta.version}`;
  const counts = [1, 2].map(tier => data.features.filter(f => f.properties.tier === tier).length);
  $('summary-title').textContent = data.meta.mode === 'overview' ? 'Regions with saved analysis' : `${data.features.length.toLocaleString()} off-field patches in view`;
  $('summary-counts').replaceChildren(...(data.meta.mode === 'overview' ? [element('span', 'Zoom in to inspect candidate areas')] :
    [element('span', `${counts[1].toLocaleString()} preferred`, 'count-preferred'), element('span', `${counts[0].toLocaleString()} best effort`, 'count-emergency')]));
  const date = new Date(data.meta.timestamp);
  $('status').textContent = data.meta.source === 'sample' ? `${data.meta.title} · prepared ${date.toLocaleDateString()}` :
    `${data.meta.visibleChunks.toLocaleString()} completed chunks in view${data.meta.pendingChunks ? ` · ${data.meta.pendingChunks.toLocaleString()} pending` : ''} · updated ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('status-dot').style.background = data.meta.source === 'sample' ? '#c0a1ff' : '#8fdf79';
  const message = $('map-message');
  message.textContent = data.meta.mode === 'overview' ? '' : data.features.length ? '' :
    data.meta.source === 'sample' ? data.meta.analyzedInView ?
      'No candidate passed within the analyzed part of this view.' : data.meta.analyzedInView === false ?
      'This view is outside the saved sample’s analysis bounds.' : data.meta.sampleCount === 0 ?
      'This saved sample was analyzed, but no off-field area passed its screening rules.' :
      'No saved sample areas in this view. Return to the sample location to inspect it.' :
    data.meta.visibleChunks ? 'No off-field candidates in this view. Airport coverage is separate. Turn on the analysis grid to see where results are available.' : `No completed v${data.meta.version} results here yet. Results appear as these chunks finish; previous builds are available in the analysis selector.`;
  message.hidden = !message.textContent;
  if (downloadedUrl) URL.revokeObjectURL(downloadedUrl);
  downloadedUrl = URL.createObjectURL(new Blob([JSON.stringify({ type: 'FeatureCollection', features: data.features })], { type: 'application/geo+json' }));
  $('download').href = downloadedUrl; $('download').download = `glide-${source.sample || 'live'}-view.geojson`;
}
async function refresh() {
  const request = ++sequence;
  controller?.abort(); controller = new AbortController();
  $('refresh').disabled = true; $('status').textContent = 'Loading this view…';
  const b = map.getBounds();
  const params = new URLSearchParams({ bbox: [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())].join(','), zoom: String(map.getZoom()), version: String(source.version) });
  if (source.sample) params.set('sample', source.sample);
  try {
    const response = await fetch(`/api/view?${params}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Preview HTTP ${response.status}`);
    if (request === sequence) render(data);
  } catch (error) {
    if (error.name !== 'AbortError' && request === sequence) {
      $('status').textContent = `Could not refresh: ${error.message}`; $('status-dot').style.background = '#f5ac78';
    }
  } finally { if (request === sequence) $('refresh').disabled = false; }
}
function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 180); }
function selectSource(version, sample = '') {
  source.version = version; source.sample = sample;
  controller?.abort(); sequence++;
  $('analysis-version').value = String(version);
}
function saveLocation() {
  const center = map.getCenter();
  const params = new URLSearchParams({ lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), zoom: String(map.getZoom()), version: String(source.version) });
  if (source.sample) params.set('sample', source.sample);
  history.replaceState(null, '', `#${params}`);
}
map.on('moveend', () => { saveLocation(); schedule(); });
map.on('mousemove', event => { $('cursor-coordinates').textContent = `${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)}`; });
$('analysis-version').addEventListener('change', () => {
  selectSource(Number($('analysis-version').value)); $('place').selectedIndex = -1;
  saveLocation(); schedule();
});
$('place').addEventListener('change', () => {
  const place = presets[$('place').value]; if (!place) return;
  selectSource(place.version ?? source.version, place.sample || '');
  map.setView(place.center, place.zoom); saveLocation(); schedule();
});
$('coordinates-form').addEventListener('submit', event => {
  event.preventDefault(); const pieces = $('coordinates').value.split(',').map(v => v.trim()), values = pieces.map(Number);
  if (pieces.length !== 2 || pieces.some(v => !v) || !values.every(Number.isFinite) || values[0] < 22 || values[0] > 52 || values[1] < -129 || values[1] > -64) {
    $('coordinate-error').textContent = 'Use latitude, longitude within CONUS.'; return;
  }
  $('coordinate-error').textContent = ''; selectSource(source.version); $('place').selectedIndex = -1;
  map.setView(values, 12); saveLocation(); schedule();
});
for (const id of ['preferred', 'emergency', 'opacity']) $(id).addEventListener('input', applyLayers);
$('compare').addEventListener('click', () => { hidden = !hidden; applyLayers(); });
$('reset').addEventListener('click', () => { hidden = false; $('preferred').checked = $('emergency').checked = true; $('opacity').value = 45; applyLayers(); });
$('grid').addEventListener('change', showCoverage);
$('refresh').addEventListener('click', refresh);
for (const [id, layer, other] of [['satellite', imagery, streets], ['streets', streets, imagery]]) {
  $(id).addEventListener('click', () => {
    map.removeLayer(other); layer.addTo(map);
    for (const key of ['satellite', 'streets']) { $(key).classList.toggle('active', key === id); $(key).setAttribute('aria-pressed', String(key === id)); }
  });
}
for (const layer of [imagery, streets]) layer.on('tileerror', () => {
  $('status').textContent = 'Some background tiles failed. Try the other basemap; candidate data is still available.';
});
async function start() {
  try {
    const versionResponse = await fetch('/api/versions'); if (!versionResponse.ok) throw new Error('Version list unavailable');
    const versions = await versionResponse.json();
    source.version = versions.current;
    $('analysis-version').replaceChildren(...versions.versions.map(version => {
      const option = element('option', `${version === versions.current ? 'Current rules' : 'Previous rules'} · v${version}`);
      option.value = String(version); return option;
    }));
    const response = await fetch('/api/samples'); if (!response.ok) throw new Error('Sample list unavailable');
    for (const sample of await response.json()) {
      const key = `sample-${sample.id}`;
      presets[key] = { center: sample.center, zoom: sample.zoom, sample: sample.id, version: sample.version };
      const option = element('option', `${sample.title} · v${sample.version} sample`); option.value = key; $('place').append(option);
    }
  } catch (error) { console.warn(error.message); }
  const state = new URLSearchParams(location.hash.slice(1));
  const version = state.get('version');
  if (version && [...$('analysis-version').options].some(option => option.value === version)) source.version = Number(version);
  if (state.has('lat') && state.has('lon') && state.has('zoom')) {
    const lat = Number(state.get('lat')), lon = Number(state.get('lon')), zoom = Number(state.get('zoom'));
    if ([lat, lon, zoom].every(Number.isFinite) && lat >= 22 && lat <= 52 && lon >= -129 && lon <= -64 && zoom >= 4 && zoom <= 18) {
      const sample = presets[`sample-${state.get('sample')}`];
      selectSource(sample?.version ?? source.version, sample?.sample || '');
      $('place').value = source.sample ? `sample-${source.sample}` : '';
      map.setView([lat, lon], zoom);
    }
  }
  $('analysis-version').value = String(source.version);
  applyLayers(); await refresh();
  setInterval(() => { if (!document.hidden && !source.sample) refresh(); }, 30_000);
}
start();
