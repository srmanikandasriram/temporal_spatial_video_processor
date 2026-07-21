/* ============================================================
   TSVP Viewer — Frontend
   ============================================================ */
'use strict';

// ---- Global state ----
const panels = new Map();
let panelCounter = 0;
let availableVariables = [];
let globalFrame = 0;
let grid = null;
let commonOffset = null;         // ADU offset (subtracted before scaling)
let commonScale  = null;         // ADU scale (divisor after offset)
let compareSelectState = { step: 0, var1: null };  // for +Compare menu

const PIXEL_COLORS = ['#4fc3f7','#ff7043','#66bb6a','#ffa726','#ab47bc','#ec407a','#26c6da','#d4e157'];
const MAX_PIXELS = PIXEL_COLORS.length;

// Shared pixel-coordinate tooltip (follows the mouse across all image panels)
const pixelCoordTooltip = document.createElement('div');
pixelCoordTooltip.id = 'pixel-coord-tooltip';
pixelCoordTooltip.style.cssText = [
  'position:fixed',
  'padding:2px 7px',
  'background:rgba(0,0,0,0.75)',
  'color:#fff',
  'font:11px/1.6 monospace',
  'border-radius:4px',
  'pointer-events:none',
  'z-index:9999',
  'display:none',
  'white-space:nowrap',
].join(';');
document.body.appendChild(pixelCoordTooltip);

function showPixelCoordTooltip(clientX, clientY, row, col) {
  pixelCoordTooltip.textContent = `col: ${col}  row: ${row}`;
  pixelCoordTooltip.style.left = `${clientX + 14}px`;
  pixelCoordTooltip.style.top  = `${clientY + 14}px`;
  pixelCoordTooltip.style.display = 'block';
}
function hidePixelCoordTooltip() {
  pixelCoordTooltip.style.display = 'none';
}

function unnorm(values, component) {
  if (commonScale === null || !Array.isArray(values)) return values;
  if (component === 'phase') return values;
  return values.map(v => v * commonScale);
}

// ---- Toast ----
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('log-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'log-toast'; el.className = 'log-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

// ---- API helpers ----
async function apiFetch(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg;
    try { msg = (await r.json()).detail || r.statusText; } catch { msg = r.statusText; }
    throw new Error(`${r.status}: ${msg}`);
  }
  return r;
}
async function apiJSON(url, opts) { return (await apiFetch(url, opts)).json(); }

// ---- Init ----
async function init() {
  grid = GridStack.init({
    column: 12, cellHeight: 60, margin: 6, animate: false,
    resizable: { handles: 'se,sw,ne,nw,e,w,s,n' },
    draggable: { handle: '.panel-header' },
  }, '#panel-grid');

  try {
    const status = await apiJSON('/api/status');
    document.getElementById('scene-name').textContent  = status.scene_name  || '';
    document.getElementById('config-path').textContent = status.config_path || '';
    commonOffset = status.common_offset ?? null;
    commonScale  = status.common_scale  ?? null;
    STEP_ORDER_UI = status.steps.map(s => s.id);
    buildStepStrip(status.steps);
    await refreshVariables();
  } catch (e) { showToast('Failed to load status: ' + e.message); }

  document.getElementById('add-panel-btn').addEventListener('click', toggleAddMenu);
  document.getElementById('compare-panel-btn').addEventListener('click', toggleCompareMenu);
  document.getElementById('clear-panels-btn').addEventListener('click', clearAllPanels);
  document.getElementById('grid-snap-btn').addEventListener('click', toggleGridLines);
  document.getElementById('link-scrubbers-btn').addEventListener('click', toggleLinkScrubbers);
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('add-panel-menu');
    if (!menu.contains(e.target) && e.target.id !== 'add-panel-btn') menu.classList.add('hidden');
    const cmenu = document.getElementById('compare-panel-menu');
    if (cmenu && !cmenu.contains(e.target) && e.target.id !== 'compare-panel-btn') cmenu.classList.add('hidden');
  });
}

// ---- Grid snap toggle ----
let gridLinesEnabled = false;
function toggleGridLines() {
  gridLinesEnabled = !gridLinesEnabled;
  const panelGrid = document.getElementById('panel-grid');
  const btn = document.getElementById('grid-snap-btn');
  panelGrid.classList.toggle('grid-lines-active', gridLinesEnabled);
  btn.classList.toggle('btn-active', gridLinesEnabled);
  btn.title = gridLinesEnabled
    ? 'Grid lines on — click to hide'
    : 'Show grid lines while dragging panels (panels always snap to the grid)';
}

// ---- Link scrubbers toggle ----
let linkScrubbersEnabled = false;
function toggleLinkScrubbers() {
  linkScrubbersEnabled = !linkScrubbersEnabled;
  const btn = document.getElementById('link-scrubbers-btn');
  btn.classList.toggle('btn-active', linkScrubbersEnabled);
  btn.title = linkScrubbersEnabled
    ? 'Scrubbers linked — click to let each panel scrub independently'
    : "Move every video panel's frame scrubber together, so all panels stay on the same frame";
  if (linkScrubbersEnabled) syncAllScrubbers(globalFrame);
}

// ---- Step strip ----
function buildStepStrip(steps) {
  const strip = document.getElementById('step-strip');
  strip.innerHTML = '';
  for (const step of steps) strip.appendChild(makeStepCard(step));
}

function makeStepCard(step) {
  const card = document.createElement('div');
  card.className = 'step-card'; card.id = `step-card-${step.id}`;
  const varsHtml = (step.variables || [])
    .map(v => `<div class="step-var">${v}</div>`).join('');
  card.innerHTML = `
    <div class="step-card-header">
      <span class="step-num">${getStepNum(step.id)}</span>
      <span class="step-label">${step.label}</span>
    </div>
    <div class="step-vars">${varsHtml}</div>`;
  return card;
}

// Populated from /api/status so it reflects the active pipeline_mode.
let STEP_ORDER_UI = [];

function getStepNum(stepId) {
  return STEP_ORDER_UI.indexOf(stepId) + 1;
}

// ---- Variables & Add Panel menu ----
async function refreshVariables() {
  try {
    availableVariables = await apiJSON('/api/variables');
    document.getElementById('add-panel-btn').disabled = availableVariables.length === 0;
    document.getElementById('compare-panel-btn').disabled = availableVariables.length < 2;
    rebuildAddMenu();
    buildCompareMenu();
  } catch (e) { console.error('refreshVariables error', e); }
}
function rebuildAddMenu() {
  const menu = document.getElementById('add-panel-menu');
  menu.innerHTML = '';
  const byStep = {};
  for (const v of availableVariables) (byStep[v.step_label] = byStep[v.step_label]||[]).push(v);
  for (const [label, vars] of Object.entries(byStep)) {
    const hdr = document.createElement('div');
    hdr.className = 'menu-section-header'; hdr.textContent = label;
    menu.appendChild(hdr);
    for (const v of vars) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.innerHTML = `<span class="menu-item-name">${v.name}</span>
        <span class="menu-item-type">${v.render_type}${v.is_complex?' ℂ':''}</span>
        <span class="menu-item-shape">${v.shape.join('×')}</span>`;
      item.addEventListener('click', () => { addPanel(v); menu.classList.add('hidden'); });
      menu.appendChild(item);
    }
  }
}
function toggleAddMenu() { document.getElementById('add-panel-menu').classList.toggle('hidden'); }

// ---- Compare Menu ----
function toggleCompareMenu() {
  const menu = document.getElementById('compare-panel-menu');
  if (menu.classList.toggle('hidden')) {
    // reset state on close
    compareSelectState = { step: 0, var1: null };
  } else {
    buildCompareMenu();
  }
}

function buildCompareMenu() {
  const menu = document.getElementById('compare-panel-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const { step, var1 } = compareSelectState;
  const hdr = document.createElement('div');
  hdr.className = 'menu-section-header';
  hdr.textContent = step === 0 ? 'Select first variable' : `Select second variable (${var1.render_type})`;
  menu.appendChild(hdr);
  const byStep = {};
  for (const v of availableVariables) {
    if (step === 1 && v.render_type !== var1.render_type) continue;
    if (step === 1 && v.name === var1.name) continue;
    (byStep[v.step_label] = byStep[v.step_label] || []).push(v);
  }
  for (const [label, vars] of Object.entries(byStep)) {
    const shdr = document.createElement('div');
    shdr.className = 'menu-section-header'; shdr.textContent = label;
    menu.appendChild(shdr);
    for (const v of vars) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      if (step === 1 && v.name === var1?.name) item.classList.add('menu-item-selected');
      item.innerHTML = `<span class="menu-item-name">${v.name}</span>
        <span class="menu-item-type">${v.render_type}${v.is_complex?' ℂ':''}</span>
        <span class="menu-item-shape">${v.shape.join('×')}</span>`;
      item.addEventListener('click', (e) => selectCompareVar(v, e));
      menu.appendChild(item);
    }
  }
}

function selectCompareVar(varInfo, e) {
  if (e) e.stopPropagation();
  if (compareSelectState.step === 0) {
    compareSelectState.step = 1;
    compareSelectState.var1 = varInfo;
    buildCompareMenu();
  } else {
    addComparisonPanel(compareSelectState.var1, varInfo);
    compareSelectState = { step: 0, var1: null };
    document.getElementById('compare-panel-menu').classList.add('hidden');
  }
}

// ---- Panels ----
function clearAllPanels() { for (const [id] of panels) removePanel(id); }

// Corrects a just-added panel's height (in grid rows) so its content area's aspect
// ratio matches the variable's real (H, W) spatial resolution, instead of guessing
// pixel sizes up front — actual column width and header/controls chrome both vary
// with viewport size and panel type, so we measure them post-layout instead.
function fitPanelHeightToAspect(panelId, shape, wrapId = `panel-wrap-${panelId}`) {
  if (!Array.isArray(shape) || shape.length < 2) return;
  const [H, W] = shape;
  if (!H || !W) return;
  // GridStack applies its layout (and the wrap's flex-derived size) asynchronously
  // after addWidget() — a single requestAnimationFrame isn't reliably late enough
  // to observe it, so defer with a short timeout instead.
  setTimeout(() => {
    const el = document.getElementById(panelId);
    const inner = document.getElementById(`panel-inner-${panelId}`);
    const wrap = document.getElementById(wrapId);
    if (!el || !inner || !wrap) return;
    const curGsH = parseFloat(el.getAttribute('gs-h')) || 6;
    const itemH = el.getBoundingClientRect().height;
    const wrapRect = wrap.getBoundingClientRect();
    if (!itemH || !curGsH || !wrapRect.width || !wrapRect.height) return;
    const pxPerRow = itemH / curGsH;
    const chromeH = itemH - wrapRect.height;  // header/controls/slider chrome above the content area
    const targetWrapH = wrapRect.width * (H / W);
    const hRows = Math.max(3, Math.min(24, Math.round((targetWrapH + chromeH) / pxPerRow)));
    if (hRows !== curGsH) grid.update(el, { h: hRows });
  }, 50);
}

function addPanel(varInfo) {
  const panelId = `panel-${++panelCounter}`;
  const widgetEl = document.createElement('div');
  widgetEl.className = 'grid-stack-item'; widgetEl.id = panelId;
  const inner = document.createElement('div');
  inner.className = 'grid-stack-item-content'; inner.id = `panel-inner-${panelId}`;
  inner.innerHTML = buildPanelSkeleton(panelId, varInfo);
  widgetEl.appendChild(inner);
  grid.addWidget(widgetEl, { w: 4, h: 6 });

  const panelData = {
    id: panelId,
    varName: varInfo.name,
    stepId: varInfo.step_id,
    renderType: varInfo.render_type,
    frameCount: varInfo.frame_count || 1,
    isComplex: varInfo.is_complex || false,
    currentFrame: 0,
    isPlaying: false, playTimer: null, fetchInFlight: false,
    settings: { cmap: 'gray', pmin: 1, pmax: 99, component: 'magnitude', clahe: true, histeq: false, refFrame: 'none', subtractRowColMean: false, derivative: 'none', derivSigmaS: 1.0, derivSigmaT: 1.0 },
    flipH: false,
    stale: false,
    plotHandle: null,
    // Video zoom/pan
    offscreenCanvas: null,
    zoom: { x0: 0, y0: 0, x1: 0, y1: 0 },  // initialized on first frame
    // Pixel explorer (video)
    pixels: [],
    pixelPlotMode: 'ri',
    pixelPlotInited: false,
    pixelPlotXMax: null,
    explorerMode: 'row',   // 'pixel' | 'row' | 'col'  (video panels only)
    // Heatmap slice
    sliceAxis: 'row',
    sliceIndex: -1,
  };
  panels.set(panelId, panelData);

  wireControls(panelId);
  initCmapSelect(`panel-cmap-${panelId}`, panelId);
  const content = inner.querySelector('.panel-content');
  if (content) new ResizeObserver(() => onPanelResize(panelId)).observe(content);
  fitPanelHeightToAspect(panelId, varInfo.shape);
  renderPanel(panelId);
}

function addComparisonPanel(varInfo1, varInfo2) {
  const panelId = `panel-${++panelCounter}`;
  const widgetEl = document.createElement('div');
  widgetEl.className = 'grid-stack-item'; widgetEl.id = panelId;
  const inner = document.createElement('div');
  inner.className = 'grid-stack-item-content'; inner.id = `panel-inner-${panelId}`;
  inner.innerHTML = buildComparisonSkeleton(panelId, varInfo1, varInfo2);
  widgetEl.appendChild(inner);
  grid.addWidget(widgetEl, { w: 6, h: 6 });

  const maxFrames = Math.max(varInfo1.frame_count || 1, varInfo2.frame_count || 1);
  const panelData = {
    id: panelId,
    isComparison: true,
    varName: varInfo1.name, stepId: varInfo1.step_id,
    varName2: varInfo2.name, stepId2: varInfo2.step_id,
    renderType: varInfo1.render_type,
    frameCount: varInfo1.frame_count || 1,
    frameCount2: varInfo2.frame_count || 1,
    isComplex: varInfo1.is_complex || false,
    isComplex2: varInfo2.is_complex || false,
    currentFrame: 0, isPlaying: false, playTimer: null, fetchInFlight: false,
    settings: { cmap: 'gray', pmin: 1, pmax: 99, component: 'magnitude', clahe: true, histeq: false, refFrame: 'none', subtractRowColMean: false, sharedRange: false, derivative: 'none', derivSigmaS: 1.0, derivSigmaT: 1.0 },
    flipH: false,
    stale: false, plotHandle: null,
    offscreenCanvas: null, offscreenCanvas2: null,
    zoom: { x0: 0, y0: 0, x1: 0, y1: 0 },
    pixels: [], pixelPlotMode: 'ri', pixelPlotInited: false, pixelPlotXMax: null,
    explorerMode: 'row',
    sliceAxis: 'row', sliceIndex: -1,
  };
  panels.set(panelId, panelData);
  wireComparisonControls(panelId);
  initCmapSelect(`panel-cmap-${panelId}`, panelId);
  const content = inner.querySelector('.panel-content');
  if (content) new ResizeObserver(() => onPanelResize(panelId)).observe(content);
  fitPanelHeightToAspect(panelId, varInfo1.shape);
  renderPanel(panelId);
}

// ============================================================
// Colormap picker — custom dropdown with inline swatch images
// ============================================================

const CMAP_LIST = [
  'inferno','magma','plasma','viridis',
  'hot','afmhot','gist_heat',
  'gray','bone','pink',
  'jet','turbo','rainbow',
  'coolwarm','bwr','RdBu','RdBu_r','BrBG','BrBG_r',
  'twilight','twilight_shifted',
  'isocontours',
];

// Hardcoded 8-stop RGB LUTs (values 0..255) for swatch generation.
// Each entry is [r,g,b] at t=0, 1/7, 2/7, ... 1.
const CMAP_LUTS = {
  inferno:   [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[252,193,7],[252,255,164]],
  magma:     [[0,0,4],[28,16,68],[79,18,123],[129,37,129],[181,54,122],[229,80,100],[251,136,97],[252,253,191]],
  plasma:    [[13,8,135],[84,2,163],[139,10,165],[185,50,137],[219,92,104],[244,136,73],[254,188,43],[240,249,33]],
  viridis:   [[68,1,84],[72,40,120],[62,83,160],[49,120,172],[53,183,121],[109,205,89],[180,222,44],[253,231,37]],
  hot:       [[11,0,0],[84,0,0],[168,0,0],[255,19,0],[255,102,0],[255,186,0],[255,255,25],[255,255,255]],
  afmhot:    [[0,0,0],[64,0,0],[128,0,0],[192,32,0],[255,96,0],[255,160,64],[255,224,128],[255,255,192]],
  gist_heat: [[0,0,0],[85,0,0],[170,0,0],[255,0,0],[255,85,0],[255,170,0],[255,255,0],[255,255,170]],
  gray:      [[0,0,0],[36,36,36],[73,73,73],[109,109,109],[145,145,145],[182,182,182],[218,218,218],[255,255,255]],
  bone:      [[0,0,0],[38,38,52],[76,85,105],[114,124,149],[152,165,192],[190,203,216],[228,228,228],[255,255,255]],
  pink:      [[30,0,0],[122,82,82],[163,116,116],[196,142,142],[222,165,165],[238,200,200],[247,230,230],[255,255,255]],
  jet:       [[0,0,128],[0,0,255],[0,128,255],[0,255,255],[128,255,128],[255,255,0],[255,128,0],[128,0,0]],
  turbo:     [[48,18,59],[86,83,201],[36,170,242],[25,219,138],[121,240,53],[239,210,22],[250,128,39],[122,4,3]],
  rainbow:   [[128,0,255],[0,0,255],[0,255,255],[0,255,0],[255,255,0],[255,128,0],[255,0,0],[128,0,0]],
  coolwarm:  [[59,76,192],[101,147,221],[172,200,237],[220,220,220],[237,180,160],[208,107,81],[180,4,38],[150,0,20]],
  bwr:       [[0,0,255],[64,64,255],[128,128,255],[192,192,255],[255,192,192],[255,128,128],[255,64,64],[255,0,0]],
  RdBu:      [[5,10,161],[60,100,200],[140,172,220],[220,220,220],[220,160,130],[200,90,60],[150,30,20],[100,0,0]],
  RdBu_r:    [[100,0,0],[150,30,20],[200,90,60],[220,160,130],[220,220,220],[140,172,220],[60,100,200],[5,10,161]],
  BrBG:      [[84,48,5],[150,88,20],[195,155,60],[235,215,160],[220,240,235],[140,210,195],[30,120,110],[0,60,48]],
  BrBG_r:    [[0,60,48],[30,120,110],[140,210,195],[220,240,235],[235,215,160],[195,155,60],[150,88,20],[84,48,5]],
  twilight:  [[226,217,226],[163,148,184],[94,86,150],[35,46,100],[46,82,139],[88,130,175],[163,186,205],[226,217,226]],
  twilight_shifted: [[114,30,83],[53,38,117],[29,63,148],[48,119,177],[106,175,191],[172,207,178],[220,211,157],[227,143,100]],
  isocontours: [[253,231,37],[94,201,98],[33,145,140],[59,82,139],[68,1,84],[253,231,37],[94,201,98],[33,145,140]],
};

function _cmapSwatchDataUrl(name, width = 120, height = 12) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  const stops = CMAP_LUTS[name] || CMAP_LUTS.inferno;
  const n = stops.length - 1;
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1) * n;
    const i = Math.min(Math.floor(t), n - 1);
    const f = t - i;
    const [r0,g0,b0] = stops[i];
    const [r1,g1,b1] = stops[i+1] || stops[i];
    const r = Math.round(r0 + f*(r1-r0));
    const g = Math.round(g0 + f*(g1-g0));
    const b = Math.round(b0 + f*(b1-b0));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, height);
  }
  return c.toDataURL('image/png');
}

// Cache of swatch data URLs, built lazily
const _cmapSwatchCache = {};
function cmapSwatchUrl(name) {
  if (!_cmapSwatchCache[name]) _cmapSwatchCache[name] = _cmapSwatchDataUrl(name);
  return _cmapSwatchCache[name];
}

// Sync the visible cmap picker trigger to a new value (used by auto-switch logic).
function syncCmapPicker(panelId, name) {
  const hidden = document.getElementById(`panel-cmap-${panelId}`);
  if (!hidden) return;
  const wrapper = hidden.previousElementSibling;
  if (!wrapper || !wrapper.classList.contains('cmap-picker')) return;
  wrapper.dataset.value = name;
  wrapper.querySelector('.cmap-name').textContent = name;
  wrapper.querySelector('.cmap-swatch').src = cmapSwatchUrl(name);
  wrapper.querySelectorAll('.cmap-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.value === name);
  });
}

// Replace a hidden <select id="..."> with a custom cmap picker.
// The hidden select is kept in sync so existing code reading .value still works.
function initCmapSelect(selectId, panelId) {
  const hidden = document.getElementById(selectId);
  if (!hidden || hidden.dataset.cmapInit) return;
  hidden.dataset.cmapInit = '1';
  hidden.style.display = 'none';

  const current = hidden.value || 'gray';

  const wrapper = document.createElement('div');
  wrapper.className = 'cmap-picker';
  wrapper.dataset.value = current;

  const trigger = document.createElement('div');
  trigger.className = 'cmap-trigger';
  trigger.innerHTML = `
    <span class="cmap-name">${current}</span>
    <img class="cmap-swatch" src="${cmapSwatchUrl(current)}" width="80" height="10" />
    <span class="cmap-arrow">▾</span>`;

  const dropdown = document.createElement('div');
  dropdown.className = 'cmap-dropdown hidden';

  for (const name of CMAP_LIST) {
    const item = document.createElement('div');
    item.className = 'cmap-item' + (name === current ? ' selected' : '');
    item.dataset.value = name;
    item.innerHTML = `<span class="cmap-item-name">${name}</span>
      <img class="cmap-item-swatch" src="${cmapSwatchUrl(name)}" width="80" height="10" />`;
    item.addEventListener('click', () => {
      hidden.value = name;
      wrapper.dataset.value = name;
      trigger.querySelector('.cmap-name').textContent = name;
      trigger.querySelector('.cmap-swatch').src = cmapSwatchUrl(name);
      dropdown.querySelectorAll('.cmap-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      dropdown.classList.add('hidden');
      // Trigger existing onCtrlChange logic
      if (panelId !== undefined) onCtrlChange(panelId);
    });
    dropdown.appendChild(item);
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  hidden.parentNode.insertBefore(wrapper, hidden);

  // Close on outside click
  document.addEventListener('click', () => dropdown.classList.add('hidden'), { capture: false });
}

function buildComparisonSkeleton(panelId, v1, v2) {
  const rt = v1.render_type;
  const cmapOpts = CMAP_LIST.map(c => `<option value="${c}" ${c==='gray'?'selected':''}>${c}</option>`).join('');
  const compOpts = ['magnitude','real','imag','phase']
    .map(c => `<option value="${c}" ${c==='magnitude'?'selected':''}>${c}</option>`).join('');
  const showCtrls = rt === 'video' || rt === 'heatmap' || rt === 'image';
  const isComplex = v1.is_complex || v2.is_complex;
  const maxFrames = Math.max(v1.frame_count||1, v2.frame_count||1);

  let body = '';
  if (rt === 'video') {
    body = `
      <div class="video-and-explorer">
        <div class="video-main-area">
          <div class="comp-canvases">
            <div class="video-wrap" id="panel-wrap-${panelId}">
              <canvas id="panel-canvas-${panelId}" class="video-canvas"></canvas>
              <div class="comp-var-label">${v1.name}</div>
            </div>
            <div class="comp-divider"></div>
            <div class="video-wrap" id="panel-wrap2-${panelId}">
              <canvas id="panel-canvas2-${panelId}" class="video-canvas"></canvas>
              <div class="comp-var-label">${v2.name}</div>
            </div>
          </div>
          <div class="panel-scrubber">
            <div class="frame-label">Frame <span id="panel-frame-label-${panelId}">0</span> / ${maxFrames-1}</div>
            <input type="range" class="frame-slider" id="panel-slider-${panelId}" min="0" max="${maxFrames-1}" value="0" step="1" />
            <div class="zoom-coords" id="zoom-coords-${panelId}"></div>
            <div class="playback-row">
              <button class="play-btn frame-step-btn" id="panel-prev-${panelId}" title="Previous frame">◀</button>
              <button class="play-btn" id="panel-play-${panelId}">▶ Play</button>
              <button class="play-btn frame-step-btn" id="panel-next-${panelId}" title="Next frame">▶|</button>
              <span class="zoom-hint">scroll=zoom · drag=pan · dbl=reset</span>
            </div>
          </div>
        </div>
        <div class="split-handle" id="split-handle-${panelId}"></div>
        <div class="pixel-exp-wrap hidden" id="pixel-exp-${panelId}">
          <div class="pixel-exp-header">
            <span class="pixel-exp-title">Explorer</span>
            <button class="pixel-mode-btn" id="exp-mode-pixel-${panelId}" onclick="setExplorerMode('${panelId}','pixel')" title="Plot pixel time series">Pixel</button>
            <button class="pixel-mode-btn active" id="exp-mode-row-${panelId}" onclick="setExplorerMode('${panelId}','row')" title="Plot row spatial profile">Row</button>
            <button class="pixel-mode-btn" id="exp-mode-col-${panelId}" onclick="setExplorerMode('${panelId}','col')" title="Plot column spatial profile">Col</button>
            <span id="exp-slice-label-${panelId}" style="opacity:0.6;min-width:46px;text-align:center;font-size:10px"></span>
            ${isComplex ? `<button class="pixel-mode-btn" id="pixel-mode-${panelId}" onclick="togglePixelMode('${panelId}')">Re/Im</button>` : ''}
            <label class="pixel-xmax-label">max x:<input type="number" id="pixel-xmax-${panelId}" class="pixel-xmax-input" min="1" step="1" placeholder="all" oninput="setPixelXMax('${panelId}',this.value)"></label>
            <button class="pixel-mode-btn" id="exp-clear-${panelId}" onclick="clearPixelExplorer('${panelId}')">Clear</button>
          </div>
          <div class="pixel-chips" id="pixel-chips-${panelId}"></div>
          <div class="pixel-exp-chart" id="pixel-chart-${panelId}"></div>
        </div>
      </div>`;
  } else if (rt === 'heatmap' || rt === 'image') {
    body = `
      <div class="video-and-explorer">
        <div class="video-main-area">
          <div class="comp-canvases" style="flex:1;min-height:0">
            <div class="heatmap-wrap" id="panel-wrap-${panelId}" style="position:relative">
              <canvas class="heatmap-canvas" id="panel-canvas-${panelId}"></canvas>
              <div class="comp-var-label">${v1.name}</div>
            </div>
            <div class="comp-divider"></div>
            <div class="heatmap-wrap" id="panel-wrap2-${panelId}" style="position:relative">
              <canvas class="heatmap-canvas" id="panel-canvas2-${panelId}"></canvas>
              <div class="comp-var-label">${v2.name}</div>
            </div>
          </div>
          <div class="panel-scrubber">
            <div class="zoom-coords" id="zoom-coords-${panelId}"></div>
          </div>
        </div>
        <div class="split-handle" id="split-handle-${panelId}"></div>
        <div class="pixel-exp-wrap hidden" id="pixel-exp-${panelId}">
          <div class="pixel-exp-header">
            <span class="pixel-exp-title">Slice</span>
            <button class="pixel-mode-btn" id="slice-axis-${panelId}" onclick="toggleSliceAxis('${panelId}')">Row</button>
            <button class="pixel-mode-btn" onclick="stepSlice('${panelId}',1)" title="Next">▲</button>
            <span id="slice-idx-label-${panelId}" style="cursor:default;opacity:0.6;min-width:38px;text-align:center;font-size:10px">—</span>
            <button class="pixel-mode-btn" onclick="stepSlice('${panelId}',-1)" title="Previous">▼</button>
            <button class="pixel-mode-btn" id="exp-clear-${panelId}" onclick="clearPixelExplorer('${panelId}')">Clear</button>
          </div>
          <div class="pixel-exp-chart" id="pixel-chart-${panelId}"></div>
        </div>
      </div>`;
  } else {
    // line / barchart — single shared plot
    body = `<div class="plot-wrap"><div class="plot-div" id="panel-plot-${panelId}"></div></div>`;
  }

  return `
    <div class="panel-header">
      <span class="panel-title" title="${v1.name} vs ${v2.name}">${v1.name} <span style="opacity:0.5">vs</span> ${v2.name}</span>
      <span class="panel-step-label">Compare</span>
      ${(rt === 'video' || rt === 'heatmap' || rt === 'image') ? `<button class="panel-btn" onclick="togglePixelExplorer('${panelId}')" title="${rt === 'video' ? 'Pixel explorer' : 'Slice plot'}">📍</button>` : ''}
      ${(rt === 'video' || rt === 'heatmap' || rt === 'image') ? `<button class="panel-btn" onclick="resetZoom('${panelId}');renderZoomed2('${panelId}')" title="Reset zoom/pan">⊡</button>` : `<button class="panel-btn" onclick="resetPlotView('${panelId}')" title="Reset view">⊡</button>`}
      ${showCtrls ? `<button class="panel-btn panel-gear-btn" onclick="togglePanelControls('${panelId}')" title="Display settings">⚙</button>` : ''}
      ${showCtrls ? `<button class="panel-btn panel-stats-btn" id="panel-stats-btn-${panelId}" onclick="togglePanelStats('${panelId}')" title="Frame statistics">∑</button>` : ''}
      ${(rt === 'video' || rt === 'heatmap' || rt === 'image') ? `<button class="panel-btn panel-flip-btn" id="panel-flip-${panelId}" onclick="toggleFlipH('${panelId}')" title="Flip horizontally">⇆</button>` : ''}
      <button class="panel-btn" onclick="exportPanelAsPNG('${panelId}')" title="Save viewport as PNG">⬇</button>
      <button class="panel-btn panel-npy-btn" onclick="exportPanelAsNpy('${panelId}')" title="Save raw data as NPY">.npy</button>
      <button class="panel-btn" onclick="removePanel('${panelId}')" title="Close">✕</button>
    </div>
    ${showCtrls ? `
    <div class="panel-controls" id="panel-ctrls-${panelId}">
      <div class="ctrl-row">
        <span class="ctrl-label">Colormap</span>
        <select class="ctrl-select" id="panel-cmap-${panelId}" onchange="onCtrlChange('${panelId}')">${cmapOpts}</select>
        <span class="ctrl-label" id="panel-iso-label-${panelId}" style="display:none">iso range</span>
        <input type="number" class="ctrl-input" id="panel-iso-${panelId}" value="1" min="0.0001" step="0.1" style="display:none" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label">pmin</span>
        <input type="number" class="ctrl-input" id="panel-pmin-${panelId}" value="1" min="0" max="100" step="0.5" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label">pmax</span>
        <input type="number" class="ctrl-input" id="panel-pmax-${panelId}" value="99" min="0" max="100" step="0.5" onchange="onCtrlChange('${panelId}')"/>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-clahe-${panelId}" checked onchange="onCtrlChange('${panelId}')"> CLAHE
        </label>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-histeq-${panelId}" onchange="onCtrlChange('${panelId}')"> HE
        </label>
        ${(rt === 'video') ? `${!isComplex ? `<label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-subdiff0-${panelId}" onchange="onRefFrameChange('${panelId}','first')"> −f₀
        </label>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-subdiffm-${panelId}" onchange="onRefFrameChange('${panelId}','mid')"> −f½
        </label>` : ''}
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-submean-${panelId}" onchange="onCtrlChange('${panelId}')"> −μᵣc
        </label>` : ''}
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-shared-range-${panelId}" onchange="onCtrlChange('${panelId}')"> Shared range
        </label>
      </div>
      ${isComplex ? `<div class="ctrl-row">
        <span class="ctrl-label">Component</span>
        <select class="ctrl-select" id="panel-comp-${panelId}" style="width:auto" onchange="onCtrlChange('${panelId}')">${compOpts}</select>
      </div>` : ''}
      ${(rt === 'video') ? `<div class="ctrl-row">
        <span class="ctrl-label">Derivative</span>
        <select class="ctrl-select" id="panel-deriv-${panelId}" style="width:auto" onchange="onCtrlChange('${panelId}')">
          <option value="none">None</option>
          <option value="dt">dI/dt</option>
          <option value="dx">dI/dx</option>
          <option value="dy">dI/dy</option>
          <option value="d2x">d²I/dx²</option>
          <option value="d2y">d²I/dy²</option>
          <option value="dxdy">d²I/dxdy</option>
          <option value="laplacian">∇²I</option>
        </select>
        <span class="ctrl-label" id="panel-deriv-sigma-s-label-${panelId}" style="display:none">σ_s</span>
        <input type="number" class="ctrl-input" id="panel-deriv-sigma-s-${panelId}" value="1.0" min="0.1" max="10" step="0.1" style="width:46px;display:none" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label" id="panel-deriv-sigma-t-label-${panelId}" style="display:none">σ_t</span>
        <input type="number" class="ctrl-input" id="panel-deriv-sigma-t-${panelId}" value="1.0" min="0.1" max="10" step="0.1" style="width:46px;display:none" onchange="onCtrlChange('${panelId}')"/>
      </div>` : ''}
    </div>` : ''}
    ${showCtrls ? `<div class="panel-stats" id="panel-stats-${panelId}"></div>` : ''}
    <div class="panel-content" id="panel-content-${panelId}">
      ${body}
      <div class="stale-overlay hidden" id="panel-stale-${panelId}">
        <div class="stale-msg">Stale — upstream step was reset.<br>Re-run the pipeline.</div>
      </div>
    </div>`;
}

function buildPanelSkeleton(panelId, varInfo) {
  const { name, step_label, render_type, frame_count, is_complex } = varInfo;
  const ctrlsId = `panel-ctrls-${panelId}`;
  const cmapOpts = CMAP_LIST.map(c => `<option value="${c}" ${c==='gray'?'selected':''}>${c}</option>`).join('');
  const compOpts = ['magnitude','real','imag','phase']
    .map(c => `<option value="${c}" ${c==='magnitude'?'selected':''}>${c}</option>`).join('');
  const showCtrls = render_type === 'video' || render_type === 'heatmap' || render_type === 'image';

  let body = '';
  if (render_type === 'video') {
    body = `
      <div class="video-and-explorer">
        <div class="video-main-area">
          <div class="video-wrap" id="panel-wrap-${panelId}">
            <canvas id="panel-canvas-${panelId}" class="video-canvas"></canvas>
          </div>
          <div class="panel-scrubber">
            <div class="frame-label">Frame <span id="panel-frame-label-${panelId}">0</span> / ${frame_count-1}</div>
            <input type="range" class="frame-slider" id="panel-slider-${panelId}"
                   min="0" max="${frame_count-1}" value="0" step="1" />
            <div class="zoom-coords" id="zoom-coords-${panelId}"></div>
            <div class="playback-row">
              <button class="play-btn frame-step-btn" id="panel-prev-${panelId}" title="Previous frame">◀</button>
              <button class="play-btn" id="panel-play-${panelId}">▶ Play</button>
              <button class="play-btn frame-step-btn" id="panel-next-${panelId}" title="Next frame">▶|</button>
              <span class="zoom-hint">scroll=zoom · drag=pan · dbl=reset</span>
            </div>
          </div>
        </div>
        <div class="split-handle" id="split-handle-${panelId}"></div>
        <div class="pixel-exp-wrap hidden" id="pixel-exp-${panelId}">
          <div class="pixel-exp-header">
            <span class="pixel-exp-title">Explorer</span>
            <button class="pixel-mode-btn" id="exp-mode-pixel-${panelId}" onclick="setExplorerMode('${panelId}','pixel')" title="Plot pixel time series">Pixel</button>
            <button class="pixel-mode-btn active" id="exp-mode-row-${panelId}" onclick="setExplorerMode('${panelId}','row')" title="Plot row spatial profile">Row</button>
            <button class="pixel-mode-btn" id="exp-mode-col-${panelId}" onclick="setExplorerMode('${panelId}','col')" title="Plot column spatial profile">Col</button>
            <span id="exp-slice-label-${panelId}" style="opacity:0.6;min-width:46px;text-align:center;font-size:10px"></span>
            ${is_complex ? `<button class="pixel-mode-btn" id="pixel-mode-${panelId}" onclick="togglePixelMode('${panelId}')">Re/Im</button>` : ''}
            <label class="pixel-xmax-label">max x:<input type="number" id="pixel-xmax-${panelId}" class="pixel-xmax-input" min="1" step="1" placeholder="all" oninput="setPixelXMax('${panelId}',this.value)"></label>
            <button class="pixel-mode-btn" id="exp-clear-${panelId}" onclick="clearPixelExplorer('${panelId}')">Clear</button>
          </div>
          <div class="pixel-chips" id="pixel-chips-${panelId}"></div>
          <div class="pixel-exp-chart" id="pixel-chart-${panelId}"></div>
        </div>
      </div>`;
  } else if (render_type === 'heatmap' || render_type === 'image') {
    body = `
      <div class="video-and-explorer">
        <div class="video-main-area">
          <div class="heatmap-wrap" id="panel-wrap-${panelId}">
            <canvas class="heatmap-canvas" id="panel-canvas-${panelId}" style="pointer-events:none"></canvas>
            <canvas class="heatmap-marker" id="panel-marker-${panelId}"></canvas>
          </div>
          <div class="panel-scrubber">
            <div class="zoom-coords" id="zoom-coords-${panelId}"></div>
          </div>
        </div>
        <div class="split-handle" id="split-handle-${panelId}"></div>
        <div class="pixel-exp-wrap hidden" id="pixel-exp-${panelId}">
          <div class="pixel-exp-header">
            <span class="pixel-exp-title">Slice</span>
            <button class="pixel-mode-btn" id="slice-axis-${panelId}" onclick="toggleSliceAxis('${panelId}')">Row</button>
            <button class="pixel-mode-btn" onclick="stepSlice('${panelId}',1)" title="Next">▲</button>
            <span id="slice-idx-label-${panelId}" style="cursor:default;opacity:0.6;min-width:38px;text-align:center;font-size:10px">—</span>
            <button class="pixel-mode-btn" onclick="stepSlice('${panelId}',-1)" title="Previous">▼</button>
          </div>
          <div class="pixel-exp-chart" id="pixel-chart-${panelId}"></div>
        </div>
      </div>`;
  } else if (render_type === 'line' || render_type === 'barchart') {
    body = `<div class="plot-wrap"><div class="plot-div" id="panel-plot-${panelId}"></div></div>`;
  }

  return `
    <div class="panel-header">
      <span class="panel-title" title="${name}">${name}</span>
      <span class="panel-step-label">${step_label||''}</span>
      ${(render_type==='video'||render_type==='heatmap'||render_type==='image') ? `<button class="panel-btn" onclick="togglePixelExplorer('${panelId}')" title="${render_type==='video'?'Pixel explorer':'Slice plot'}">📍</button>` : ''}
      ${(render_type==='video'||render_type==='heatmap'||render_type==='image') ? `<button class="panel-btn" onclick="resetZoom('${panelId}')" title="Reset zoom/pan">⊡</button>` : (render_type==='line'||render_type==='barchart') ? `<button class="panel-btn" onclick="resetPlotView('${panelId}')" title="Reset view">⊡</button>` : ''}
      ${showCtrls ? `<button class="panel-btn panel-gear-btn" onclick="togglePanelControls('${panelId}')" title="Display settings">⚙</button>` : ''}
      ${showCtrls ? `<button class="panel-btn panel-stats-btn" id="panel-stats-btn-${panelId}" onclick="togglePanelStats('${panelId}')" title="Frame statistics">∑</button>` : ''}
      ${(render_type==='video'||render_type==='heatmap'||render_type==='image') ? `<button class="panel-btn panel-flip-btn" id="panel-flip-${panelId}" onclick="toggleFlipH('${panelId}')" title="Flip horizontally">⇆</button>` : ''}
      <button class="panel-btn" onclick="exportPanelAsPNG('${panelId}')" title="Save viewport as PNG">⬇</button>
      <button class="panel-btn panel-npy-btn" onclick="exportPanelAsNpy('${panelId}')" title="Save raw data as NPY">.npy</button>
      ${render_type === 'video' ? `<button class="panel-btn panel-mp4-btn" onclick="exportPanelAsMp4('${panelId}')" title="Render current display settings as MP4">.mp4</button>` : ''}
      <button class="panel-btn" onclick="removePanel('${panelId}')" title="Close">✕</button>
    </div>
    ${showCtrls ? `
    <div class="panel-controls" id="${ctrlsId}">
      <div class="ctrl-row">
        <span class="ctrl-label">Colormap</span>
        <select class="ctrl-select" id="panel-cmap-${panelId}" onchange="onCtrlChange('${panelId}')">${cmapOpts}</select>
        <span class="ctrl-label" id="panel-iso-label-${panelId}" style="display:none">iso range</span>
        <input type="number" class="ctrl-input" id="panel-iso-${panelId}" value="1" min="0.0001" step="0.1" style="display:none" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label">pmin</span>
        <input type="number" class="ctrl-input" id="panel-pmin-${panelId}" value="1" min="0" max="100" step="0.5" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label">pmax</span>
        <input type="number" class="ctrl-input" id="panel-pmax-${panelId}" value="99" min="0" max="100" step="0.5" onchange="onCtrlChange('${panelId}')"/>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-clahe-${panelId}" checked onchange="onCtrlChange('${panelId}')"> CLAHE
        </label>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-histeq-${panelId}" onchange="onCtrlChange('${panelId}')"> HE
        </label>
        ${(render_type === 'video') ? `${!is_complex ? `<label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-subdiff0-${panelId}" onchange="onRefFrameChange('${panelId}','first')"> −f₀
        </label>
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-subdiffm-${panelId}" onchange="onRefFrameChange('${panelId}','mid')"> −f½
        </label>` : ''}
        <label class="ctrl-label" style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" id="panel-submean-${panelId}" onchange="onCtrlChange('${panelId}')"> −μᵣc
        </label>` : ''}
      </div>
      ${is_complex ? `<div class="ctrl-row">
        <span class="ctrl-label">Component</span>
        <select class="ctrl-select" id="panel-comp-${panelId}" style="width:auto" onchange="onCtrlChange('${panelId}')">${compOpts}</select>
      </div>` : ''}
      ${(render_type === 'video') ? `<div class="ctrl-row">
        <span class="ctrl-label">Derivative</span>
        <select class="ctrl-select" id="panel-deriv-${panelId}" style="width:auto" onchange="onCtrlChange('${panelId}')">
          <option value="none">None</option>
          <option value="dt">dI/dt</option>
          <option value="dx">dI/dx</option>
          <option value="dy">dI/dy</option>
          <option value="d2x">d²I/dx²</option>
          <option value="d2y">d²I/dy²</option>
          <option value="dxdy">d²I/dxdy</option>
          <option value="laplacian">∇²I</option>
        </select>
        <span class="ctrl-label" id="panel-deriv-sigma-s-label-${panelId}" style="display:none">σ_s</span>
        <input type="number" class="ctrl-input" id="panel-deriv-sigma-s-${panelId}" value="1.0" min="0.1" max="10" step="0.1" style="width:46px;display:none" onchange="onCtrlChange('${panelId}')"/>
        <span class="ctrl-label" id="panel-deriv-sigma-t-label-${panelId}" style="display:none">σ_t</span>
        <input type="number" class="ctrl-input" id="panel-deriv-sigma-t-${panelId}" value="1.0" min="0.1" max="10" step="0.1" style="width:46px;display:none" onchange="onCtrlChange('${panelId}')"/>
      </div>` : ''}
    </div>` : ''}
    ${showCtrls ? `<div class="panel-stats" id="panel-stats-${panelId}"></div>` : ''}
    <div class="panel-content" id="panel-content-${panelId}">
      ${body}
      <div class="stale-overlay hidden" id="panel-stale-${panelId}">
        <div class="stale-msg">Stale — upstream step was reset.<br>Re-run the pipeline.</div>
      </div>
    </div>`;
}

function togglePanelControls(panelId) {
  document.getElementById(`panel-ctrls-${panelId}`)?.classList.toggle('open');
}

function formatPanelStat(v) {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1000 || (abs < 0.001 && abs > 0)) return v.toExponential(3);
  return v.toPrecision(5);
}

function refreshPanelStatsIfOpen(panelId) {
  const statsDiv = document.getElementById(`panel-stats-${panelId}`);
  if (statsDiv?.classList.contains('open')) refreshPanelStatsContent(panelId);
}

async function refreshPanelStatsContent(panelId) {
  const statsDiv = document.getElementById(`panel-stats-${panelId}`);
  const p = panels.get(panelId);
  if (!statsDiv || !p) return;
  try {
    const names = p.isComparison ? [p.varName, p.varName2] : [p.varName];
    const component = p.settings.component || 'magnitude';
    const frame = p.currentFrame || 0;
    const refFrame = p.settings.refFrame || 'none';
    const subtractRowColMean = p.settings.subtractRowColMean || false;
    const results = await Promise.all(names.map(async (name) => {
      const params = new URLSearchParams({ frame_index: String(frame), component, ref_frame: refFrame, subtract_rowcol_mean: subtractRowColMean });
      const resp = await fetch(`/api/variable/${encodeURIComponent(name)}/frame-stats?${params}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { name, stats: await resp.json() };
    }));
    const rows = ['min','max','mean','std','p1','p99','frobenius','coeff_mag_max'];
    const rowLabels = ['min','max','mean','std','p1','p99','‖·‖F','coeff_mag_max'];
    statsDiv.innerHTML = results.map(({ name, stats }) =>
      `<div class="stats-group">
        <div class="ctrl-label" style="margin-bottom:2px;font-weight:600">${name}</div>
        ${rows.map((k, i) =>
          k === 'coeff_mag_max'
            ? `<div class="stats-row" style="border-top:1px solid var(--border);margin-top:3px;padding-top:3px"><span class="stats-label" style="color:var(--accent)">${rowLabels[i]}</span><span style="color:var(--accent)">${stats[k] != null ? formatPanelStat(stats[k]) : '—'}</span></div>`
            : `<div class="stats-row"><span class="stats-label">${rowLabels[i]}</span><span>${formatPanelStat(stats[k])}</span></div>`
        ).join('')}
      </div>`
    ).join('');
  } catch (e) {
    statsDiv.innerHTML = `<span class="ctrl-label" style="color:#e07070">Error: ${e.message}</span>`;
  }
}

async function togglePanelStats(panelId) {
  const statsDiv = document.getElementById(`panel-stats-${panelId}`);
  if (!statsDiv) return;
  if (statsDiv.classList.contains('open')) {
    statsDiv.classList.remove('open');
    statsDiv.innerHTML = '';
    return;
  }
  statsDiv.classList.add('open');
  statsDiv.innerHTML = '<span class="ctrl-label">Loading…</span>';
  await refreshPanelStatsContent(panelId);
}

function onCtrlChange(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  const newComp = document.getElementById(`panel-comp-${panelId}`)?.value || 'magnitude';
  const prevComp = p.settings.component;
  p.settings.cmap      = document.getElementById(`panel-cmap-${panelId}`)?.value || 'gray';
  p.settings.pmin      = parseFloat(document.getElementById(`panel-pmin-${panelId}`)?.value || 1);
  p.settings.pmax      = parseFloat(document.getElementById(`panel-pmax-${panelId}`)?.value || 99);
  const isPhase = newComp === 'phase';
  // Phase controls: force-disable CLAHE, HE, and percentile clipping
  const claheEl  = document.getElementById(`panel-clahe-${panelId}`);
  const histeqEl = document.getElementById(`panel-histeq-${panelId}`);
  const pminEl   = document.getElementById(`panel-pmin-${panelId}`);
  const pmaxEl   = document.getElementById(`panel-pmax-${panelId}`);
  if (isPhase) {
    if (claheEl)  { claheEl.checked  = false; claheEl.disabled  = true; }
    if (histeqEl) { histeqEl.checked = false; histeqEl.disabled = true; }
    if (pminEl)   pminEl.disabled = true;
    if (pmaxEl)   pmaxEl.disabled = true;
  } else {
    if (claheEl)  claheEl.disabled  = false;
    if (histeqEl) histeqEl.disabled = false;
    if (pminEl)   pminEl.disabled = false;
    if (pmaxEl)   pmaxEl.disabled = false;
  }
  p.settings.clahe   = !isPhase && (claheEl?.checked  || false);
  p.settings.histeq  = !isPhase && (histeqEl?.checked || false);
  p.settings.pmin    = parseFloat(pminEl?.value || 1);
  p.settings.pmax    = parseFloat(pmaxEl?.value || 99);
  const isIso = p.settings.cmap === 'isocontours';
  const isoLabel = document.getElementById(`panel-iso-label-${panelId}`);
  const isoInput = document.getElementById(`panel-iso-${panelId}`);
  if (isoLabel) isoLabel.style.display = isIso ? '' : 'none';
  if (isoInput) isoInput.style.display = isIso ? '' : 'none';
  p.settings.isocontourRange = parseFloat(isoInput?.value || 1);
  p.settings.sharedRange = document.getElementById(`panel-shared-range-${panelId}`)?.checked || false;
  p.settings.subtractRowColMean = document.getElementById(`panel-submean-${panelId}`)?.checked || false;
  p.settings.component = newComp;

  // Derivative controls
  const prevDeriv = p.settings.derivative || 'none';
  const newDeriv = document.getElementById(`panel-deriv-${panelId}`)?.value || 'none';
  p.settings.derivative = newDeriv;
  p.settings.derivSigmaS = parseFloat(document.getElementById(`panel-deriv-sigma-s-${panelId}`)?.value || 1.0);
  p.settings.derivSigmaT = parseFloat(document.getElementById(`panel-deriv-sigma-t-${panelId}`)?.value || 1.0);
  // Show sigma_s for spatial derivatives, sigma_t only for dt
  const sigmaSLabel = document.getElementById(`panel-deriv-sigma-s-label-${panelId}`);
  const sigmaSInput = document.getElementById(`panel-deriv-sigma-s-${panelId}`);
  const sigmaTLabel = document.getElementById(`panel-deriv-sigma-t-label-${panelId}`);
  const sigmaTInput = document.getElementById(`panel-deriv-sigma-t-${panelId}`);
  const isTemporal = newDeriv === 'dt';
  const isSpatial = newDeriv !== 'none' && !isTemporal;
  if (sigmaSLabel) sigmaSLabel.style.display = isSpatial ? '' : 'none';
  if (sigmaSInput) sigmaSInput.style.display = isSpatial ? '' : 'none';
  if (sigmaTLabel) sigmaTLabel.style.display = isTemporal ? '' : 'none';
  if (sigmaTInput) sigmaTInput.style.display = isTemporal ? '' : 'none';

  // Auto-switch colormap to twilight for phase, restore previous non-phase cmap when leaving
  if (newComp !== prevComp) {
    const cmapEl = document.getElementById(`panel-cmap-${panelId}`);
    if (isPhase && cmapEl && !cmapEl.value.startsWith('twilight')) {
      p._savedCmap = cmapEl.value;
      cmapEl.value = 'twilight';
      p.settings.cmap = 'twilight';
      syncCmapPicker(panelId, 'twilight');
    } else if (prevComp === 'phase' && !isPhase && cmapEl && p._savedCmap) {
      cmapEl.value = p._savedCmap;
      p.settings.cmap = p._savedCmap;
      syncCmapPicker(panelId, p._savedCmap);
      delete p._savedCmap;
    }
  }
  applyDisplaySettings(panelId);
}

function onRefFrameChange(panelId, which) {
  const p = panels.get(panelId);
  if (!p) return;
  const cb0 = document.getElementById(`panel-subdiff0-${panelId}`);
  const cbm = document.getElementById(`panel-subdiffm-${panelId}`);
  // Toggle: clicking an already-checked box clears selection
  const prev = p.settings.refFrame;
  const next = (prev === which) ? 'none' : which;
  p.settings.refFrame = next;
  if (cb0) cb0.checked = (next === 'first');
  if (cbm) cbm.checked = (next === 'mid');
  applyDisplaySettings(panelId);
}

function applyDisplaySettings(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  renderPanel(panelId);
  if ((p.renderType === 'heatmap' || p.renderType === 'image') && p.sliceIndex >= 0)
    fetchAndUpdateHeatmapSlice(panelId);
}

function wireControls(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  if (p.isComparison) return;  // comparison panels use wireComparisonControls

  // Scrubber
  const slider = document.getElementById(`panel-slider-${panelId}`);
  if (slider) {
    slider.addEventListener('input', () => {
      const f = parseInt(slider.value);
      p.currentFrame = f;
      document.getElementById(`panel-frame-label-${panelId}`).textContent = f;
      if (linkScrubbersEnabled) { globalFrame = f; syncAllScrubbers(f); }
      else fetchAndDrawFrame(panelId, f);
    });
  }
  const playBtn = document.getElementById(`panel-play-${panelId}`);
  if (playBtn) playBtn.addEventListener('click', () => togglePlay(panelId));

  const prevBtn = document.getElementById(`panel-prev-${panelId}`);
  if (prevBtn) prevBtn.addEventListener('click', () => stepFrame(panelId, -1));
  const nextBtn = document.getElementById(`panel-next-${panelId}`);
  if (nextBtn) nextBtn.addEventListener('click', () => stepFrame(panelId, 1));

  // Video: zoom + pan + click-to-add-pixel
  if (p.renderType === 'video') {
    const canvas = document.getElementById(`panel-canvas-${panelId}`);
    if (canvas) {
      canvas.style.cursor = 'crosshair';

      // Wheel → zoom centered on cursor
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        zoomVideoAt(panelId, mx, my, e.deltaY < 0 ? 1/1.15 : 1.15);
      }, { passive: false });

      // Mouse drag → pan; no-move click → add pixel
      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const startX = e.clientX, startY = e.clientY;
        const z0 = { ...p.zoom };
        let moved = false;
        canvas.style.cursor = 'grabbing';

        const lb0 = getLetterboxRect(panelId) || { dstW: canvas.offsetWidth || 1, dstH: canvas.offsetHeight || 1 };
        function onMove(ev) {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          moved = true;
          const vW = z0.x1 - z0.x0, vH = z0.y1 - z0.y0;
          p.zoom.x0 = z0.x0 - dx / lb0.dstW * vW;
          p.zoom.y0 = z0.y0 - dy / lb0.dstH * vH;
          p.zoom.x1 = p.zoom.x0 + vW;
          p.zoom.y1 = p.zoom.y0 + vH;
          renderZoomed(panelId);
        }
        function onUp(ev) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          canvas.style.cursor = 'crosshair';
          if (!moved) {
            // Treat as click → add pixel or set row/col slice
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
            if (mx >= 0 && mx < rect.width && my >= 0 && my < rect.height) {
              const { row, col } = screenToData(panelId, mx, my);
              const mode = panels.get(panelId)?.explorerMode || 'pixel';
              if (mode === 'row') setVideoSlice(panelId, row);
              else if (mode === 'col') setVideoSlice(panelId, col);
              else addPixelToPanel(panelId, row, col);
            }
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Pixel-coordinate tooltip
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const { row, col } = screenToData(panelId, e.clientX - rect.left, e.clientY - rect.top);
        showPixelCoordTooltip(e.clientX, e.clientY, row, col);
      });
      canvas.addEventListener('mouseleave', hidePixelCoordTooltip);

      // Double-click → reset zoom
      canvas.addEventListener('dblclick', () => resetZoom(panelId));
    }
  }

  // Heatmap: zoom/pan/slice on the marker overlay canvas
  if (p.renderType === 'heatmap' || p.renderType === 'image') {
    const marker = document.getElementById(`panel-marker-${panelId}`);
    if (marker) {
      marker.style.cursor = 'crosshair';

      // Wheel → zoom
      marker.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = marker.getBoundingClientRect();
        zoomVideoAt(panelId, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1/1.15 : 1.15);
      }, { passive: false });

      // Mousedown → pan, or drag marker band, or set new slice
      marker.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const startX = e.clientX, startY = e.clientY;
        const z0 = { ...p.zoom };
        let moved = false;
        const lb0 = getLetterboxRect(panelId) || { dstW: marker.offsetWidth||1, dstH: marker.offsetHeight||1, dstX:0, dstY:0 };
        const rect0 = marker.getBoundingClientRect();
        const sx0 = e.clientX - rect0.left, sy0 = e.clientY - rect0.top;

        // Check proximity to marker band for drag
        let markerDrag = false;
        if (p.sliceIndex >= 0 && p.offscreenCanvas) {
          const { x0, y0, x1, y1 } = p.zoom;
          if (p.sliceAxis === 'row') {
            const screenY = lb0.dstY + (p.sliceIndex + 0.5 - y0) / (y1 - y0) * lb0.dstH;
            markerDrag = Math.abs(sy0 - screenY) < 10;
          } else {
            const screenX = lb0.dstX + (p.sliceIndex + 0.5 - x0) / (x1 - x0) * lb0.dstW;
            markerDrag = Math.abs(sx0 - screenX) < 10;
          }
        }

        if (markerDrag) {
          // Drag the slice marker
          marker.style.cursor = p.sliceAxis === 'row' ? 'ns-resize' : 'ew-resize';
          function onMarkerMove(ev) {
            const r2 = marker.getBoundingClientRect();
            const sx2 = ev.clientX - r2.left, sy2 = ev.clientY - r2.top;
            const { row, col } = screenToData(panelId, sx2, sy2);
            const newIndex = p.sliceAxis === 'row' ? row : col;
            if (newIndex !== p.sliceIndex) {
              p.sliceIndex = newIndex;
              const lbl = document.getElementById(`slice-idx-label-${panelId}`);
              if (lbl) lbl.textContent = `${p.sliceAxis}=${newIndex}`;
              drawHeatmapMarker(panelId);
              fetchAndUpdateHeatmapSlice(panelId);
            }
          }
          function onMarkerUp() {
            marker.style.cursor = 'crosshair';
            document.removeEventListener('mousemove', onMarkerMove);
            document.removeEventListener('mouseup', onMarkerUp);
          }
          document.addEventListener('mousemove', onMarkerMove);
          document.addEventListener('mouseup', onMarkerUp);
        } else {
          // Pan or click-to-set-slice
          marker.style.cursor = 'grabbing';
          function onMove(ev) {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
            moved = true;
            const vW = z0.x1 - z0.x0, vH = z0.y1 - z0.y0;
            p.zoom.x0 = z0.x0 - dx / lb0.dstW * vW;
            p.zoom.y0 = z0.y0 - dy / lb0.dstH * vH;
            p.zoom.x1 = p.zoom.x0 + vW; p.zoom.y1 = p.zoom.y0 + vH;
            renderZoomed(panelId);
          }
          function onUp(ev) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            marker.style.cursor = 'crosshair';
            if (!moved) {
              const rect = marker.getBoundingClientRect();
              const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
              const { row, col } = screenToData(panelId, mx, my);
              setHeatmapSlice(panelId, p.sliceAxis === 'row' ? row : col);
            }
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }
      });

      // Pixel-coordinate tooltip
      marker.addEventListener('mousemove', (e) => {
        const rect = marker.getBoundingClientRect();
        const { row, col } = screenToData(panelId, e.clientX - rect.left, e.clientY - rect.top);
        showPixelCoordTooltip(e.clientX, e.clientY, row, col);
      });
      marker.addEventListener('mouseleave', hidePixelCoordTooltip);

      // Double-click → reset zoom
      marker.addEventListener('dblclick', () => resetZoom(panelId));
    }
  }

  wireSplitHandle(panelId);
}

function stepFrame(panelId, delta) {
  const p = panels.get(panelId);
  if (!p) return;
  const next = Math.max(0, Math.min(p.frameCount - 1, p.currentFrame + delta));
  p.currentFrame = next;
  const slider = document.getElementById(`panel-slider-${panelId}`);
  if (slider) slider.value = next;
  const lbl = document.getElementById(`panel-frame-label-${panelId}`);
  if (lbl) lbl.textContent = next;
  if (linkScrubbersEnabled) { globalFrame = next; syncAllScrubbers(next); }
  else {
    fetchAndDrawFrame(panelId, next);
    if (p.isComparison) fetchAndDrawFrame2(panelId, next);
  }
}

function togglePlay(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  if (p.isPlaying) {
    clearInterval(p.playTimer); p.isPlaying = false;
    document.getElementById(`panel-play-${panelId}`).textContent = '▶ Play';
  } else {
    p.isPlaying = true;
    document.getElementById(`panel-play-${panelId}`).textContent = '⏸ Pause';
    p.playTimer = setInterval(() => {
      const next = (p.currentFrame + 1) % p.frameCount;
      p.currentFrame = next;
      const slider = document.getElementById(`panel-slider-${panelId}`);
      if (slider) slider.value = next;
      const lbl = document.getElementById(`panel-frame-label-${panelId}`);
      if (lbl) lbl.textContent = next;
      if (!p.fetchInFlight) {
        fetchAndDrawFrame(panelId, next);
        if (p.isComparison) fetchAndDrawFrame2(panelId, next);
      }
    }, 50);
  }
}

function syncAllScrubbers(frameIndex) {
  for (const [id, p] of panels) {
    if (p.renderType !== 'video') continue;
    p.currentFrame = frameIndex;
    const slider = document.getElementById(`panel-slider-${id}`);
    if (slider) { slider.value = Math.min(frameIndex, p.frameCount-1); document.getElementById(`panel-frame-label-${id}`).textContent = slider.value; }
    fetchAndDrawFrame(id, Math.min(frameIndex, p.frameCount-1));
  }
}

// ---- Video zoom/pan helpers ----

// Letterbox rect: the destination rect inside the canvas that preserves data aspect ratio.
function getLetterboxRect(panelId) {
  const p = panels.get(panelId);
  const canvas = document.getElementById(`panel-canvas-${panelId}`);
  if (!p || !canvas || !canvas.width || !canvas.height) return null;
  const { x0, y0, x1, y1 } = p.zoom;
  const vW = x1 - x0, vH = y1 - y0;
  if (!vW || !vH) return null;
  const dispW = canvas.width, dispH = canvas.height;
  const dataAspect = vW / vH, dispAspect = dispW / dispH;
  let dstX, dstY, dstW, dstH;
  if (dataAspect > dispAspect) {
    dstW = dispW; dstH = dispW / dataAspect;
    dstX = 0;    dstY = (dispH - dstH) / 2;
  } else {
    dstH = dispH; dstW = dispH * dataAspect;
    dstX = (dispW - dstW) / 2; dstY = 0;
  }
  return { dstX, dstY, dstW, dstH };
}

function zoomVideoAt(panelId, screenX, screenY, factor) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas) return;
  const lb = getLetterboxRect(panelId);
  if (!lb) return;
  const { x0, y0, x1, y1 } = p.zoom;
  const vW = x1 - x0, vH = y1 - y0;
  const relX = (screenX - lb.dstX) / lb.dstW;
  const relY = (screenY - lb.dstY) / lb.dstH;
  const dataX = x0 + relX * vW, dataY = y0 + relY * vH;
  const oW = p.offscreenCanvas.width, oH = p.offscreenCanvas.height;
  const newW = Math.max(4, Math.min(oW, vW * factor));
  const newH = Math.max(4, Math.min(oH, vH * factor));
  p.zoom.x0 = dataX - relX * newW;
  p.zoom.y0 = dataY - relY * newH;
  p.zoom.x1 = p.zoom.x0 + newW;
  p.zoom.y1 = p.zoom.y0 + newH;
  renderZoomed(panelId);
}

function resetZoom(panelId) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas) return;
  p.zoom = { x0: 0, y0: 0, x1: p.offscreenCanvas.width, y1: p.offscreenCanvas.height };
  renderZoomed(panelId);
}

function screenToData(panelId, screenX, screenY) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas) return { row: 0, col: 0 };
  const lb = getLetterboxRect(panelId);
  if (!lb) return { row: 0, col: 0 };
  const { x0, y0, x1, y1 } = p.zoom;
  const dataX = x0 + ((screenX - lb.dstX) / lb.dstW) * (x1 - x0);
  const dataY = y0 + ((screenY - lb.dstY) / lb.dstH) * (y1 - y0);
  return {
    col: Math.max(0, Math.min(p.offscreenCanvas.width  - 1, Math.floor(dataX))),
    row: Math.max(0, Math.min(p.offscreenCanvas.height - 1, Math.floor(dataY))),
  };
}

function dataToScreen(panelId, row, col) {
  const p  = panels.get(panelId);
  const lb = getLetterboxRect(panelId);
  if (!lb || !p) return { x: 0, y: 0 };
  const { x0, y0, x1, y1 } = p.zoom;
  return {
    x: lb.dstX + (col + 0.5 - x0) / (x1 - x0) * lb.dstW,
    y: lb.dstY + (row + 0.5 - y0) / (y1 - y0) * lb.dstH,
  };
}

function toggleFlipH(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  p.flipH = !p.flipH;
  const btn = document.getElementById(`panel-flip-${panelId}`);
  if (btn) btn.classList.toggle('panel-btn-active', p.flipH);
  renderZoomed(panelId);
}

// Snap the zoom rect to integer pixel coordinates in place, so a given
// scroll/pan gesture always lands on the same crop (repeatable exports).
function snapZoomToInt(p) {
  if (!p?.zoom) return;
  p.zoom.x0 = Math.round(p.zoom.x0);
  p.zoom.y0 = Math.round(p.zoom.y0);
  p.zoom.x1 = Math.round(p.zoom.x1);
  p.zoom.y1 = Math.round(p.zoom.y1);
  if (p.zoom.x1 <= p.zoom.x0) p.zoom.x1 = p.zoom.x0 + 1;
  if (p.zoom.y1 <= p.zoom.y0) p.zoom.y1 = p.zoom.y0 + 1;
}

function renderZoomed(panelId) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas) return;
  snapZoomToInt(p);
  const canvas = document.getElementById(`panel-canvas-${panelId}`);
  const wrap   = document.getElementById(`panel-wrap-${panelId}`);
  if (!canvas || !wrap) return;
  const dispW = wrap.clientWidth, dispH = wrap.clientHeight;
  if (!dispW || !dispH) return;
  if (canvas.width !== dispW || canvas.height !== dispH) {
    canvas.width = dispW; canvas.height = dispH;
  }
  const { x0, y0, x1, y1 } = p.zoom;
  const lb = getLetterboxRect(panelId);
  if (!lb) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dispW, dispH);
  ctx.imageSmoothingEnabled = false;
  if (p.flipH) {
    ctx.save();
    ctx.translate(dispW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(p.offscreenCanvas, x0, y0, x1 - x0, y1 - y0, dispW - lb.dstX - lb.dstW, lb.dstY, lb.dstW, lb.dstH);
    ctx.restore();
  } else {
    ctx.drawImage(p.offscreenCanvas, x0, y0, x1 - x0, y1 - y0, lb.dstX, lb.dstY, lb.dstW, lb.dstH);
  }
  if (p.pixels.length > 0) drawStarMarkers(panelId);
  if ((p.renderType === 'heatmap' || p.renderType === 'image') && !p.isComparison) {
    drawHeatmapMarker(panelId);
  }
  if ((p.renderType === 'heatmap' || p.renderType === 'image') && p.isComparison && p.sliceIndex >= 0) {
    const ctx1 = canvas.getContext('2d');
    drawSliceMarkerOnCtx(ctx1, lb, p, dispW, dispH);
  }
  if (p.renderType === 'video' && p.explorerMode !== 'pixel' && p.sliceIndex >= 0) {
    drawVideoSliceMarker(panelId);
  }
  updateZoomCoordsLabel(panelId);
}

function updateZoomCoordsLabel(panelId) {
  const p = panels.get(panelId);
  if (p?.zoomCoordsEditing) return;  // don't clobber the edit form while open
  const el = document.getElementById(`zoom-coords-${panelId}`);
  if (!el || !p?.zoom) return;
  const { x0, y0, x1, y1 } = p.zoom;
  el.innerHTML = `<span class="zoom-coords-text" onclick="startZoomCoordsEdit('${panelId}')" title="Click to edit crop coordinates">` +
    `x: ${Math.round(x0)}–${Math.round(x1)}  y: ${Math.round(y0)}–${Math.round(y1)}  (${Math.round(x1 - x0)}×${Math.round(y1 - y0)})</span>`;
}

function startZoomCoordsEdit(panelId) {
  const p = panels.get(panelId);
  const el = document.getElementById(`zoom-coords-${panelId}`);
  if (!p?.zoom || !el) return;
  p.zoomCoordsEditing = true;
  const { x0, y0, x1, y1 } = p.zoom;
  const maxW = p.offscreenCanvas?.width, maxH = p.offscreenCanvas?.height;
  const field = (id, val) => `<input type="number" class="zoom-coords-input" id="${id}-${panelId}" value="${Math.round(val)}" step="1" />`;
  el.innerHTML =
    `<span class="zoom-coords-edit">` +
    `x:${field('zc-x0', x0)}–${field('zc-x1', x1)}` +
    `y:${field('zc-y0', y0)}–${field('zc-y1', y1)}` +
    `<button class="zoom-coords-btn" onclick="applyZoomCoordsEdit('${panelId}')" title="Apply">✓</button>` +
    `<button class="zoom-coords-btn" onclick="cancelZoomCoordsEdit('${panelId}')" title="Cancel">✕</button>` +
    `</span>`;
  const inputs = ['zc-x0', 'zc-y0', 'zc-x1', 'zc-y1'].map(id => document.getElementById(`${id}-${panelId}`));
  inputs.forEach(inp => {
    if (!inp) return;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyZoomCoordsEdit(panelId);
      else if (e.key === 'Escape') cancelZoomCoordsEdit(panelId);
    });
  });
  if (inputs[0]) { inputs[0].focus(); inputs[0].select(); }
}

function cancelZoomCoordsEdit(panelId) {
  const p = panels.get(panelId);
  if (p) p.zoomCoordsEditing = false;
  updateZoomCoordsLabel(panelId);
}

function applyZoomCoordsEdit(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  const get = (id) => parseFloat(document.getElementById(`${id}-${panelId}`)?.value);
  let x0 = get('zc-x0'), y0 = get('zc-y0'), x1 = get('zc-x1'), y1 = get('zc-y1');
  if ([x0, y0, x1, y1].some(v => !isFinite(v))) { cancelZoomCoordsEdit(panelId); return; }
  const maxW = p.offscreenCanvas?.width ?? Math.max(x0, x1);
  const maxH = p.offscreenCanvas?.height ?? Math.max(y0, y1);
  x0 = Math.max(0, Math.min(maxW - 1, x0));
  y0 = Math.max(0, Math.min(maxH - 1, y0));
  x1 = Math.max(x0 + 1, Math.min(maxW, x1));
  y1 = Math.max(y0 + 1, Math.min(maxH, y1));
  p.zoom = { x0, y0, x1, y1 };
  p.zoomCoordsEditing = false;
  renderZoomed(panelId);
  if (p.isComparison) renderZoomed2(panelId);
}

// ---- Rendering ----
async function renderPanel(panelId) {
  const p = panels.get(panelId);
  if (!p || p.stale) return;
  try {
    if (p.isComparison) {
      if (p.renderType === 'video') {
        await fetchAndDrawFrame(panelId, p.currentFrame);
        await fetchAndDrawFrame2(panelId, p.currentFrame);
      } else if (p.renderType === 'heatmap' || p.renderType === 'image') {
        await fetchAndDrawHeatmap(panelId);
        await fetchAndDrawHeatmap2(panelId);
      } else {
        await fetchAndDrawComparisonChart(panelId);
      }
    } else if (p.renderType === 'video')   await fetchAndDrawFrame(panelId, p.currentFrame);
    else if (p.renderType === 'heatmap' || p.renderType === 'image') await fetchAndDrawHeatmap(panelId);
    else if (p.renderType === 'line')    await fetchAndDrawLine(panelId);
    else if (p.renderType === 'barchart') await fetchAndDrawBar(panelId);
  } catch (e) { console.error(`renderPanel(${panelId}) error:`, e); }
  refreshPanelStatsIfOpen(panelId);
}

async function fetchAndDrawComparisonChart(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  const div = document.getElementById(`panel-plot-${panelId}`);
  if (!div) return;
  try {
    const [d1, d2] = await Promise.all([
      apiJSON(`/api/variable/${p.varName}/${p.renderType === 'line' ? 'series-json' : 'barchart-json'}`),
      apiJSON(`/api/variable/${p.varName2}/${p.renderType === 'line' ? 'series-json' : 'barchart-json'}`),
    ]);
    const layout = getPlotLayout();
    let traces;
    if (p.renderType === 'line') {
      traces = [
        { x: Array.from({length: d1.values.length}, (_,i) => i), y: d1.values, type:'scatter', mode:'lines',
          name: p.varName, line:{ color:'#4fc3f7', width:1 } },
        { x: Array.from({length: d2.values.length}, (_,i) => i), y: d2.values, type:'scatter', mode:'lines',
          name: p.varName2, line:{ color:'#ff7043', width:1 } },
      ];
    } else {
      traces = [
        { x: d1.labels, y: d1.values, type:'bar', name: p.varName, marker:{ color:'#4fc3f7' } },
        { x: d2.labels, y: d2.values, type:'bar', name: p.varName2, marker:{ color:'#ff7043' } },
      ];
    }
    layout.barmode = 'group';
    layout.showlegend = true;
    layout.legend = { orientation: 'h', x: 0, y: -0.15, font: { size: 9 } };
    const opts = { responsive:true, displayModeBar:false, scrollZoom:true };
    if (p.plotHandle) Plotly.react(div, traces, layout, opts);
    else { Plotly.newPlot(div, traces, layout, opts); p.plotHandle = div; }
  } catch (e) { console.error('comparison chart error', e); }
}

const PI = Math.PI;

async function getSharedVminVmax(p, frameIndex) {
  const { pmin, pmax, component } = p.settings;
  const fi1 = frameIndex ?? p.frameIndex ?? 0;
  const fi2 = Math.min(fi1, (p.frameCount2 ?? fi1 + 1) - 1);
  const [s1, s2] = await Promise.all([
    apiJSON(`/api/variable/${p.varName}/frame-stats?frame_index=${fi1}&pmin=${pmin}&pmax=${pmax}&component=${component}`).catch(() => null),
    apiJSON(`/api/variable/${p.varName2}/frame-stats?frame_index=${fi2}&pmin=${pmin}&pmax=${pmax}&component=${component}`).catch(() => null),
  ]);
  if (!s1 || !s2) return null;
  return { vmin: Math.min(s1.vmin, s2.vmin), vmax: Math.max(s1.vmax, s2.vmax) };
}

async function fetchAndDrawFrame(panelId, frameIndex) {
  const p = panels.get(panelId);
  if (!p) return;
  p.fetchInFlight = true;
  const { cmap, pmin, pmax, component, clahe, histeq = false, refFrame = 'none', subtractRowColMean = false, isocontourRange = 1, sharedRange, derivative = 'none', derivSigmaS = 1.0, derivSigmaT = 1.0 } = p.settings;
  const meanSuffix = subtractRowColMean ? '&subtract_rowcol_mean=true' : '';

  // In comparison mode with shared contrast enhancement, use the joint endpoint
  // which computes the CDF from both frames together.
  // Skip joint endpoint when a derivative is active (not supported there).
  if (p.isComparison && (histeq || clahe) && p.varName2 && derivative === 'none') {
    try {
      const clampedFrame2 = Math.min(frameIndex, p.frameCount2 - 1);
      const url = `/api/compare/frame-rgba?name1=${p.varName}&name2=${p.varName2}&frame_index=${frameIndex}&cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}&ref_frame=${refFrame}${meanSuffix}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const w1 = parseInt(resp.headers.get('X-Frame-Width'));
      const h1 = parseInt(resp.headers.get('X-Frame-Height'));
      const w2 = parseInt(resp.headers.get('X-Frame2-Width'));
      const h2 = parseInt(resp.headers.get('X-Frame2-Height'));
      const fc1 = parseInt(resp.headers.get('X-Frame-Count') || p.frameCount);
      const fc2 = parseInt(resp.headers.get('X-Frame-Count2') || p.frameCount2);
      p.frameCount = fc1; p.frameCount2 = fc2;
      const full = await resp.arrayBuffer();
      const bytes1 = w1 * h1 * 4;
      const buf1 = full.slice(0, bytes1);
      const buf2 = full.slice(bytes1);
      if (!p.offscreenCanvas) { p.offscreenCanvas = document.createElement('canvas'); p.zoom = { x0:0, y0:0, x1:w1, y1:h1 }; }
      else if (p.offscreenCanvas.width !== w1 || p.offscreenCanvas.height !== h1) { p.zoom = { x0:0, y0:0, x1:w1, y1:h1 }; }
      p.offscreenCanvas.width = w1; p.offscreenCanvas.height = h1;
      p.offscreenCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf1), w1, h1), 0, 0);
      renderZoomed(panelId);
      if (!p.offscreenCanvas2) p.offscreenCanvas2 = document.createElement('canvas');
      p.offscreenCanvas2.width = w2; p.offscreenCanvas2.height = h2;
      p.offscreenCanvas2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf2), w2, h2), 0, 0);
      if (!p.zoom.x1) p.zoom = { x0:0, y0:0, x1:w2, y1:h2 };
      renderZoomed2(panelId);
      if (p.explorerMode !== 'pixel' && p.sliceIndex >= 0) fetchAndUpdateVideoSlice(panelId);
      refreshPanelStatsIfOpen(panelId);
    } catch {} finally { p.fetchInFlight = false; }
    return;
  }

  let sharedSuffix = component === 'phase' ? `&vmin=${-PI}&vmax=${PI}` : '';
  if (!sharedSuffix && p.isComparison && sharedRange) {
    const sv = await getSharedVminVmax(p, frameIndex);
    if (sv) sharedSuffix = `&vmin=${sv.vmin}&vmax=${sv.vmax}`;
  }
  const derivSuffix = derivative !== 'none' ? `&derivative=${derivative}&deriv_sigma_s=${derivSigmaS}&deriv_sigma_t=${derivSigmaT}` : '';
  const url = `/api/variable/${p.varName}/frame-rgba?frame_index=${frameIndex}&cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}&ref_frame=${refFrame}&isocontour_range=${isocontourRange}${sharedSuffix}${derivSuffix}${meanSuffix}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const w  = parseInt(resp.headers.get('X-Frame-Width'));
    const h  = parseInt(resp.headers.get('X-Frame-Height'));
    const fc = parseInt(resp.headers.get('X-Frame-Count') || p.frameCount);
    p.frameCount = fc;
    const buf = await resp.arrayBuffer();

    // Write to off-screen canvas at full data resolution
    if (!p.offscreenCanvas) {
      p.offscreenCanvas = document.createElement('canvas');
      p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    } else if (p.offscreenCanvas.width !== w || p.offscreenCanvas.height !== h) {
      p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    }
    p.offscreenCanvas.width  = w;
    p.offscreenCanvas.height = h;
    p.offscreenCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    renderZoomed(panelId);
    if (p.explorerMode !== 'pixel' && p.sliceIndex >= 0) fetchAndUpdateVideoSlice(panelId);
    refreshPanelStatsIfOpen(panelId);
  } catch {} finally {
    p.fetchInFlight = false;
  }
}

async function fetchAndDrawHeatmap(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  const { cmap, pmin, pmax, component, clahe, histeq = false, isocontourRange = 1, sharedRange } = p.settings;

  // In comparison mode with shared contrast enhancement, use the joint endpoint.
  if (p.isComparison && (histeq || clahe) && p.varName2) {
    try {
      const url = `/api/compare/heatmap-rgba?name1=${p.varName}&name2=${p.varName2}&cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const w1 = parseInt(resp.headers.get('X-Frame-Width'));
      const h1 = parseInt(resp.headers.get('X-Frame-Height'));
      const w2 = parseInt(resp.headers.get('X-Frame2-Width'));
      const h2 = parseInt(resp.headers.get('X-Frame2-Height'));
      const full = await resp.arrayBuffer();
      const bytes1 = w1 * h1 * 4;
      const buf1 = full.slice(0, bytes1);
      const buf2 = full.slice(bytes1);
      if (!p.offscreenCanvas) { p.offscreenCanvas = document.createElement('canvas'); p.zoom = { x0:0, y0:0, x1:w1, y1:h1 }; }
      else if (p.offscreenCanvas.width !== w1 || p.offscreenCanvas.height !== h1) { p.zoom = { x0:0, y0:0, x1:w1, y1:h1 }; }
      p.offscreenCanvas.width = w1; p.offscreenCanvas.height = h1;
      p.offscreenCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf1), w1, h1), 0, 0);
      renderZoomed(panelId);
      if (!p.offscreenCanvas2) p.offscreenCanvas2 = document.createElement('canvas');
      p.offscreenCanvas2.width = w2; p.offscreenCanvas2.height = h2;
      p.offscreenCanvas2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf2), w2, h2), 0, 0);
      if (!p.zoom.x1) p.zoom = { x0:0, y0:0, x1:w2, y1:h2 };
      renderZoomed2(panelId);
    } catch {}
    return;
  }

  let sharedSuffix = component === 'phase' ? `&vmin=${-PI}&vmax=${PI}` : '';
  if (!sharedSuffix && p.isComparison && sharedRange) {
    const sv = await getSharedVminVmax(p, p.frameIndex ?? 0);
    if (sv) sharedSuffix = `&vmin=${sv.vmin}&vmax=${sv.vmax}`;
  }
  const url = `/api/variable/${p.varName}/heatmap-rgba?cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}&isocontour_range=${isocontourRange}${sharedSuffix}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const w = parseInt(resp.headers.get('X-Frame-Width'));
    const h = parseInt(resp.headers.get('X-Frame-Height'));
    const buf = await resp.arrayBuffer();
    // Store to offscreen canvas and use renderZoomed (same as video)
    if (!p.offscreenCanvas) {
      p.offscreenCanvas = document.createElement('canvas');
      p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    } else if (p.offscreenCanvas.width !== w || p.offscreenCanvas.height !== h) {
      p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    }
    p.offscreenCanvas.width = w; p.offscreenCanvas.height = h;
    p.offscreenCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    renderZoomed(panelId);
  } catch {}
}

async function fetchAndDrawLine(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  try {
    const data = await apiJSON(`/api/variable/${p.varName}/series-json`);
    const div  = document.getElementById(`panel-plot-${panelId}`);
    if (!div) return;
    const x = Array.from({length: data.values.length}, (_, i) => i);
    const traces = [{ x, y: data.values, type: 'scatter', mode: 'lines', name: 'Re', line: { color: '#4fc3f7', width: 1 } }];
    if (data.is_complex && data.imag_values) {
      traces.push({ x, y: data.imag_values, type: 'scatter', mode: 'lines', name: 'Im', line: { color: '#ef9a9a', width: 1 } });
    }
    const layout = { ...getPlotLayout(), showlegend: !!data.is_complex,
      legend: { font: { size: 9 }, orientation: 'h', y: -0.35 } };
    if (p.plotHandle) Plotly.react(div, traces, layout, {responsive:true, displayModeBar:false, scrollZoom:true});
    else { Plotly.newPlot(div, traces, layout, {responsive:true, displayModeBar:false, scrollZoom:true}); p.plotHandle = div; }
  } catch (e) { console.error('line plot error', e); }
}

async function fetchAndDrawBar(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  try {
    const data = await apiJSON(`/api/variable/${p.varName}/barchart-json`);
    const div  = document.getElementById(`panel-plot-${panelId}`);
    if (!div) return;
    const trace = { x: data.labels, y: data.values, type: 'bar', marker: { color: '#4fc3f7' } };
    const layout = getPlotLayout();
    if (p.plotHandle) Plotly.react(div, [trace], layout, {responsive:true, displayModeBar:false, scrollZoom:true});
    else { Plotly.newPlot(div, [trace], layout, {responsive:true, displayModeBar:false, scrollZoom:true}); p.plotHandle = div; }
  } catch (e) { console.error('bar plot error', e); }
}

function getPlotLayout(yTitle) {
  return {
    paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1a1a1a',
    font: { color: '#cccccc', size: 10 },
    margin: { t: 8, r: 8, b: 36, l: 48 },
    xaxis: { gridcolor: '#333', zerolinecolor: '#444' },
    yaxis: { gridcolor: '#333', zerolinecolor: '#444',
             title: yTitle ? { text: yTitle, font: { size: 9 } } : undefined },
    dragmode: 'pan',
    autosize: true,
  };
}

function resetPlotView(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  const div = document.getElementById(`panel-plot-${panelId}`);
  if (div && p.plotHandle) {
    Plotly.relayout(div, {'xaxis.autorange': true, 'yaxis.autorange': true});
  }
}

function drawStarMarkers(panelId) {
  const p = panels.get(panelId);
  if (!p?.pixels.length) return;
  const canvas = document.getElementById(`panel-canvas-${panelId}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const ARM = 7;  // screen-space pixels, constant regardless of zoom
  for (const { row, col, color } of p.pixels) {
    const { x, y } = dataToScreen(panelId, row, col);
    if (x < -ARM || x > canvas.width + ARM || y < -ARM || y > canvas.height + ARM) continue;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.setLineDash([]);
    const d = ARM * 0.7;
    [[-ARM,0,ARM,0],[0,-ARM,0,ARM],[-d,-d,d,d],[d,-d,-d,d]].forEach(([dx1,dy1,dx2,dy2]) => {
      ctx.beginPath(); ctx.moveTo(x+dx1, y+dy1); ctx.lineTo(x+dx2, y+dy2); ctx.stroke();
    });
    ctx.restore();
  }
}

function onPanelResize(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  if (p.renderType === 'video' || p.renderType === 'heatmap' || p.renderType === 'image') {
    if (p.offscreenCanvas) renderZoomed(panelId);
    if (p.isComparison && p.offscreenCanvas2) renderZoomed2(panelId);
  } else if (p.renderType === 'line' || p.renderType === 'barchart') {
    const div = document.getElementById(`panel-plot-${panelId}`);
    if (div && p.plotHandle) Plotly.relayout(div, { autosize: true });
  }
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (chartDiv && p.pixelPlotInited) Plotly.relayout(chartDiv, { autosize: true });
}

function removePanel(panelId) {
  const p = panels.get(panelId);
  if (p?.playTimer) clearInterval(p.playTimer);
  try { const d = document.getElementById(`panel-plot-${panelId}`);  if (d && p?.plotHandle)      Plotly.purge(d); } catch {}
  try { const d = document.getElementById(`pixel-chart-${panelId}`); if (d && p?.pixelPlotInited) Plotly.purge(d); } catch {}
  const el = document.getElementById(panelId);
  if (el) grid.removeWidget(el, true);
  panels.delete(panelId);
}

// ---- Split-handle resize ----
function wireSplitHandle(panelId) {
  const handle = document.getElementById(`split-handle-${panelId}`);
  const expEl  = document.getElementById(`pixel-exp-${panelId}`);
  if (!handle || !expEl) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = expEl.getBoundingClientRect().width;
    const container  = expEl.closest('.video-and-explorer');
    handle.classList.add('dragging');

    function onMove(ev) {
      const containerW = container.getBoundingClientRect().width;
      const newW = Math.max(100, Math.min(containerW - 80, startWidth + (startX - ev.clientX)));
      expEl.style.width = newW + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      renderZoomed(panelId);  // re-fit video canvas after resize
      const p = panels.get(panelId);
      if (p?.isComparison) renderZoomed2(panelId);
      if (p?.pixelPlotInited) {
        const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
        if (chartDiv) Plotly.relayout(chartDiv, { autosize: true });
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---- Comparison panel controls ----
function wireComparisonControls(panelId) {
  const p = panels.get(panelId);
  if (!p) return;

  // Scrubber + play (same as video)
  const slider = document.getElementById(`panel-slider-${panelId}`);
  if (slider) {
    slider.addEventListener('input', () => {
      const f = parseInt(slider.value);
      p.currentFrame = f;
      document.getElementById(`panel-frame-label-${panelId}`).textContent = f;
      fetchAndDrawFrame(panelId, f);
      fetchAndDrawFrame2(panelId, f);
    });
  }
  const playBtn = document.getElementById(`panel-play-${panelId}`);
  if (playBtn) playBtn.addEventListener('click', () => togglePlay(panelId));

  const prevBtn2 = document.getElementById(`panel-prev-${panelId}`);
  if (prevBtn2) prevBtn2.addEventListener('click', () => stepFrame(panelId, -1));
  const nextBtn2 = document.getElementById(`panel-next-${panelId}`);
  if (nextBtn2) nextBtn2.addEventListener('click', () => stepFrame(panelId, 1));

  // Wire both canvases (zoom+pan shared, click adds pixel)
  function wireCompCanvas(canvasId, isCanvas2) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomVideoAt(panelId, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1/1.15 : 1.15);
      renderZoomed(panelId); renderZoomed2(panelId);
    }, { passive: false });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX, startY = e.clientY;
      const z0 = { ...p.zoom };
      let moved = false;
      canvas.style.cursor = 'grabbing';
      const lb0 = isCanvas2 ? getLetterboxRectForCanvas(p.zoom, canvas)
                             : (getLetterboxRect(panelId) || { dstW: canvas.offsetWidth||1, dstH: canvas.offsetHeight||1 });
      function onMove(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        moved = true;
        const vW = z0.x1 - z0.x0, vH = z0.y1 - z0.y0;
        p.zoom.x0 = z0.x0 - dx / (lb0?.dstW||1) * vW;
        p.zoom.y0 = z0.y0 - dy / (lb0?.dstH||1) * vH;
        p.zoom.x1 = p.zoom.x0 + vW; p.zoom.y1 = p.zoom.y0 + vH;
        renderZoomed(panelId); renderZoomed2(panelId);
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        canvas.style.cursor = 'crosshair';
        if (!moved) {
          const rect = canvas.getBoundingClientRect();
          const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
          if (mx >= 0 && mx < rect.width && my >= 0 && my < rect.height) {
            const { row, col } = isCanvas2
              ? screenToDataCanvas2(panelId, mx, my)
              : screenToData(panelId, mx, my);
            const mode = p.explorerMode || 'pixel';
            if (mode === 'row') setVideoSlice(panelId, row);
            else if (mode === 'col') setVideoSlice(panelId, col);
            else addPixelToPanel(panelId, row, col);
          }
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    canvas.addEventListener('dblclick', () => {
      resetZoom(panelId);
      renderZoomed(panelId); renderZoomed2(panelId);
    });

    // Pixel-coordinate tooltip
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { row, col } = isCanvas2
        ? screenToDataCanvas2(panelId, mx, my)
        : screenToData(panelId, mx, my);
      showPixelCoordTooltip(e.clientX, e.clientY, row, col);
    });
    canvas.addEventListener('mouseleave', hidePixelCoordTooltip);
  }

  if (p.renderType === 'video') {
    wireCompCanvas(`panel-canvas-${panelId}`, false);
    wireCompCanvas(`panel-canvas2-${panelId}`, true);
  }

  if (p.renderType === 'heatmap' || p.renderType === 'image') {
    function wireHeatmapCompCanvas(canvasId, isCanvas2) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomVideoAt(panelId, e.clientX - canvas.getBoundingClientRect().left, e.clientY - canvas.getBoundingClientRect().top, e.deltaY < 0 ? 1/1.15 : 1.15);
        renderZoomed(panelId); renderZoomed2(panelId);
      }, { passive: false });
      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const startX = e.clientX, startY = e.clientY;
        const z0 = { ...p.zoom };
        let moved = false;
        canvas.style.cursor = 'grabbing';
        const lb0 = isCanvas2 ? getLetterboxRectForCanvas(p.zoom, canvas)
                               : (getLetterboxRect(panelId) || { dstW: canvas.offsetWidth||1, dstH: canvas.offsetHeight||1 });
        function onMove(ev) {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
          moved = true;
          const vW = z0.x1 - z0.x0, vH = z0.y1 - z0.y0;
          p.zoom.x0 = z0.x0 - dx / (lb0?.dstW||1) * vW;
          p.zoom.y0 = z0.y0 - dy / (lb0?.dstH||1) * vH;
          p.zoom.x1 = p.zoom.x0 + vW; p.zoom.y1 = p.zoom.y0 + vH;
          renderZoomed(panelId); renderZoomed2(panelId);
        }
        function onUp(ev) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          canvas.style.cursor = 'crosshair';
          if (!moved) {
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
            if (mx >= 0 && mx < rect.width && my >= 0 && my < rect.height) {
              const { row, col } = isCanvas2 ? screenToDataCanvas2(panelId, mx, my) : screenToData(panelId, mx, my);
              setHeatmapSlice(panelId, p.sliceAxis === 'row' ? row : col);
            }
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      canvas.addEventListener('dblclick', () => {
        resetZoom(panelId);
        renderZoomed(panelId); renderZoomed2(panelId);
      });
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const { row, col } = isCanvas2 ? screenToDataCanvas2(panelId, mx, my) : screenToData(panelId, mx, my);
        showPixelCoordTooltip(e.clientX, e.clientY, row, col);
      });
      canvas.addEventListener('mouseleave', hidePixelCoordTooltip);
    }
    wireHeatmapCompCanvas(`panel-canvas-${panelId}`, false);
    wireHeatmapCompCanvas(`panel-canvas2-${panelId}`, true);
  }

  wireSplitHandle(panelId);
}

// ---- Canvas2 helpers for comparison panels ----
function getLetterboxRectForCanvas(zoom, canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const { x0, y0, x1, y1 } = zoom;
  const vW = x1 - x0, vH = y1 - y0;
  if (!vW || !vH) return null;
  const dispW = canvas.width, dispH = canvas.height;
  const dataAspect = vW / vH, dispAspect = dispW / dispH;
  let dstX, dstY, dstW, dstH;
  if (dataAspect > dispAspect) {
    dstW = dispW; dstH = dispW / dataAspect; dstX = 0; dstY = (dispH - dstH) / 2;
  } else {
    dstH = dispH; dstW = dispH * dataAspect; dstX = (dispW - dstW) / 2; dstY = 0;
  }
  return { dstX, dstY, dstW, dstH };
}

function screenToDataCanvas2(panelId, screenX, screenY) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas2) return { row: 0, col: 0 };
  const canvas = document.getElementById(`panel-canvas2-${panelId}`);
  if (!canvas) return { row: 0, col: 0 };
  const { x0, y0, x1, y1 } = p.zoom;
  if (!(x1 - x0) || !(y1 - y0)) return { row: 0, col: 0 };

  // Use the same scaled zoom as renderZoomed2
  const W1 = p.offscreenCanvas?.width  || (x1 - x0);
  const H1 = p.offscreenCanvas?.height || (y1 - y0);
  const W2 = p.offscreenCanvas2.width;
  const H2 = p.offscreenCanvas2.height;
  const scaleX = W2 / W1, scaleY = H2 / H1;
  const sx0 = x0 * scaleX, sy0 = y0 * scaleY;
  const sw  = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;

  const dispW = canvas.width || canvas.offsetWidth;
  const dispH = canvas.height || canvas.offsetHeight;
  const dataAspect = sw / sh, dispAspect = dispW / dispH;
  let dstX, dstY, dstW, dstH;
  if (dataAspect > dispAspect) {
    dstW = dispW; dstH = dispW / dataAspect; dstX = 0; dstY = (dispH - dstH) / 2;
  } else {
    dstH = dispH; dstW = dispH * dataAspect; dstX = (dispW - dstW) / 2; dstY = 0;
  }

  // Result is in var1 coordinate space (for consistent pixel storage with canvas1 clicks)
  const col2 = sx0 + (screenX - dstX) / dstW * sw;
  const row2 = sy0 + (screenY - dstY) / dstH * sh;
  return {
    col: Math.max(0, Math.min(W1 - 1, Math.floor(col2 / scaleX))),
    row: Math.max(0, Math.min(H1 - 1, Math.floor(row2 / scaleY))),
  };
}

// Draw a row or column slice marker directly onto a canvas 2d context.
// lb = { dstX, dstY, dstW, dstH }, p.zoom and p.sliceAxis/sliceIndex used for position.
function drawSliceMarkerOnCtx(ctx, lb, p, dispW, dispH) {
  const { x0, y0, x1, y1 } = p.zoom;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 220, 50, 0.9)';
  ctx.fillStyle   = 'rgba(255, 220, 50, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  if (p.sliceAxis === 'row') {
    const fy = (p.sliceIndex + 0.5 - y0) / (y1 - y0);
    const sy = lb.dstY + fy * lb.dstH;
    if (sy < lb.dstY - 2 || sy > lb.dstY + lb.dstH + 2) { ctx.restore(); return; }
    const bandH = Math.max(2, lb.dstH / (y1 - y0));
    ctx.fillRect(lb.dstX, sy - bandH / 2, lb.dstW, bandH);
    ctx.beginPath(); ctx.moveTo(lb.dstX, sy); ctx.lineTo(lb.dstX + lb.dstW, sy); ctx.stroke();
  } else {
    const fx = (p.sliceIndex + 0.5 - x0) / (x1 - x0);
    const sx = lb.dstX + fx * lb.dstW;
    if (sx < lb.dstX - 2 || sx > lb.dstX + lb.dstW + 2) { ctx.restore(); return; }
    const bandW = Math.max(2, lb.dstW / (x1 - x0));
    ctx.fillRect(sx - bandW / 2, lb.dstY, bandW, lb.dstH);
    ctx.beginPath(); ctx.moveTo(sx, lb.dstY); ctx.lineTo(sx, lb.dstY + lb.dstH); ctx.stroke();
  }
  ctx.restore();
}

function renderZoomed2(panelId) {
  const p = panels.get(panelId);
  if (!p?.offscreenCanvas2) return;
  snapZoomToInt(p);
  const canvas = document.getElementById(`panel-canvas2-${panelId}`);
  const wrap   = document.getElementById(`panel-wrap2-${panelId}`);
  if (!canvas || !wrap) return;
  const dispW = wrap.clientWidth, dispH = wrap.clientHeight;
  if (!dispW || !dispH) return;
  if (canvas.width !== dispW || canvas.height !== dispH) { canvas.width = dispW; canvas.height = dispH; }

  const { x0, y0, x1, y1 } = p.zoom;
  if (!(x1 - x0) || !(y1 - y0)) return;

  // Scale zoom rect from var1 coordinate space into var2 coordinate space so that
  // the letterbox is computed from var2's actual aspect ratio.
  const W1 = p.offscreenCanvas?.width  || (x1 - x0);
  const H1 = p.offscreenCanvas?.height || (y1 - y0);
  const W2 = p.offscreenCanvas2.width;
  const H2 = p.offscreenCanvas2.height;
  const scaleX = W2 / W1, scaleY = H2 / H1;
  const sx0 = x0 * scaleX, sy0 = y0 * scaleY;
  const sw  = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;

  // Letterbox based on var2's aspect ratio
  const dataAspect = sw / sh, dispAspect = dispW / dispH;
  let dstX, dstY, dstW, dstH;
  if (dataAspect > dispAspect) {
    dstW = dispW; dstH = dispW / dataAspect; dstX = 0; dstY = (dispH - dstH) / 2;
  } else {
    dstH = dispH; dstW = dispH * dataAspect; dstX = (dispW - dstW) / 2; dstY = 0;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dispW, dispH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(p.offscreenCanvas2, sx0, sy0, sw, sh, dstX, dstY, dstW, dstH);

  if ((p.renderType === 'heatmap' || p.renderType === 'image') && p.sliceIndex >= 0) {
    // Slice index is in var1 space; scale to var2 space for correct marker position.
    const lb2 = { dstX, dstY, dstW, dstH };
    const scaledIdx = p.sliceAxis === 'row' ? Math.round(p.sliceIndex * scaleY) : Math.round(p.sliceIndex * scaleX);
    const zoom2 = { x0: x0 * scaleX, y0: y0 * scaleY, x1: x1 * scaleX, y1: y1 * scaleY };
    drawSliceMarkerOnCtx(ctx, lb2, { sliceAxis: p.sliceAxis, sliceIndex: scaledIdx, zoom: zoom2 }, dispW, dispH);
  }

  if (p.pixels.length > 0) {
    const ARM = 7;
    for (const { row, col, color } of p.pixels) {
      // Map pixel coords (var1 space) into var2 space, then to screen
      const c2 = (col + 0.5) * scaleX, r2 = (row + 0.5) * scaleY;
      const x = dstX + (c2 - sx0) / sw * dstW;
      const y = dstY + (r2 - sy0) / sh * dstH;
      if (x < -ARM || x > dispW + ARM || y < -ARM || y > dispH + ARM) continue;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.setLineDash([]);
      const d = ARM * 0.7;
      [[-ARM,0,ARM,0],[0,-ARM,0,ARM],[-d,-d,d,d],[d,-d,-d,d]].forEach(([dx1,dy1,dx2,dy2]) => {
        ctx.beginPath(); ctx.moveTo(x+dx1, y+dy1); ctx.lineTo(x+dx2, y+dy2); ctx.stroke();
      });
      ctx.restore();
    }
  }
}

async function fetchAndDrawFrame2(panelId, frameIndex) {
  const p = panels.get(panelId);
  if (!p?.varName2) return;
  // Joint endpoint already rendered both canvases; nothing left to do.
  if (p.isComparison && (p.settings.histeq || p.settings.clahe) && (p.settings.derivative || 'none') === 'none') return;
  const { cmap, pmin, pmax, component, clahe, histeq = false, refFrame = 'none', subtractRowColMean = false, isocontourRange = 1, sharedRange, derivative = 'none', derivSigmaS = 1.0, derivSigmaT = 1.0 } = p.settings;
  const clampedFrame = Math.min(frameIndex, p.frameCount2 - 1);
  let sharedSuffix = component === 'phase' ? `&vmin=${-PI}&vmax=${PI}` : '';
  if (!sharedSuffix && sharedRange) {
    const sv = await getSharedVminVmax(p, frameIndex);
    if (sv) sharedSuffix = `&vmin=${sv.vmin}&vmax=${sv.vmax}`;
  }
  const derivSuffix = derivative !== 'none' ? `&derivative=${derivative}&deriv_sigma_s=${derivSigmaS}&deriv_sigma_t=${derivSigmaT}` : '';
  const meanSuffix2 = subtractRowColMean ? '&subtract_rowcol_mean=true' : '';
  const url = `/api/variable/${p.varName2}/frame-rgba?frame_index=${clampedFrame}&cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}&ref_frame=${refFrame}&isocontour_range=${isocontourRange}${sharedSuffix}${derivSuffix}${meanSuffix2}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const w  = parseInt(resp.headers.get('X-Frame-Width'));
    const h  = parseInt(resp.headers.get('X-Frame-Height'));
    const buf = await resp.arrayBuffer();
    if (!p.offscreenCanvas2) {
      p.offscreenCanvas2 = document.createElement('canvas');
    }
    p.offscreenCanvas2.width = w; p.offscreenCanvas2.height = h;
    p.offscreenCanvas2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    // Sync zoom from canvas1 if not yet initialized
    if (!p.zoom.x1) p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    renderZoomed2(panelId);
  } catch {}
}

async function fetchAndDrawHeatmap2(panelId) {
  const p = panels.get(panelId);
  if (!p?.varName2) return;
  // Joint endpoint already rendered both canvases; nothing left to do.
  if (p.isComparison && (p.settings.histeq || p.settings.clahe)) return;
  const { cmap, pmin, pmax, component, clahe, histeq = false, isocontourRange = 1, sharedRange } = p.settings;
  let sharedSuffix = component === 'phase' ? `&vmin=${-PI}&vmax=${PI}` : '';
  if (!sharedSuffix && sharedRange) {
    const sv = await getSharedVminVmax(p, p.frameIndex ?? 0);
    if (sv) sharedSuffix = `&vmin=${sv.vmin}&vmax=${sv.vmax}`;
  }
  const url = `/api/variable/${p.varName2}/heatmap-rgba?cmap=${cmap}&pmin=${pmin}&pmax=${pmax}&component=${component}&clahe=${clahe}&histeq=${histeq}&isocontour_range=${isocontourRange}${sharedSuffix}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const w = parseInt(resp.headers.get('X-Frame-Width'));
    const h = parseInt(resp.headers.get('X-Frame-Height'));
    const buf = await resp.arrayBuffer();
    if (!p.offscreenCanvas2) p.offscreenCanvas2 = document.createElement('canvas');
    p.offscreenCanvas2.width = w; p.offscreenCanvas2.height = h;
    p.offscreenCanvas2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    if (!p.zoom.x1) p.zoom = { x0: 0, y0: 0, x1: w, y1: h };
    renderZoomed2(panelId);
  } catch {}
}

// ---- Pixel Explorer ----
function showPixelExplorer(panelId) {
  const expEl    = document.getElementById(`pixel-exp-${panelId}`);
  const handleEl = document.getElementById(`split-handle-${panelId}`);
  if (!expEl) return;
  if (!expEl.style.width) {
    const container = expEl.closest('.video-and-explorer');
    if (container) {
      const w = Math.max(120, Math.floor(container.getBoundingClientRect().width * 0.45));
      expEl.style.width = w + 'px';
    }
  }
  expEl.classList.remove('hidden');
  if (handleEl) handleEl.style.display = 'block';
  // Re-fit video to new narrower width
  renderZoomed(panelId);
  const sp = panels.get(panelId);
  if (sp?.isComparison) renderZoomed2(panelId);
}

function hidePixelExplorer(panelId) {
  document.getElementById(`pixel-exp-${panelId}`)?.classList.add('hidden');
  const handleEl = document.getElementById(`split-handle-${panelId}`);
  if (handleEl) handleEl.style.display = 'none';
  renderZoomed(panelId);
  const hp = panels.get(panelId);
  if (hp?.isComparison) renderZoomed2(panelId);
}

function togglePixelExplorer(panelId) {
  const expEl = document.getElementById(`pixel-exp-${panelId}`);
  if (!expEl) return;
  if (expEl.classList.contains('hidden')) showPixelExplorer(panelId);
  else hidePixelExplorer(panelId);
}

function togglePixelMode(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  p.pixelPlotMode = (p.pixelPlotMode === 'ri') ? 'mp' : 'ri';
  const btn = document.getElementById(`pixel-mode-${panelId}`);
  if (btn) btn.textContent = (p.pixelPlotMode === 'ri') ? 'Re/Im' : 'Mag/Ph';
  p.pixelPlotInited = false;
  if (p.pixels.length > 0) fetchAndUpdatePixelPlot(panelId);
}

function setPixelXMax(panelId, val) {
  const p = panels.get(panelId);
  if (!p) return;
  const n = parseInt(val);
  p.pixelPlotXMax = (isNaN(n) || n <= 0) ? null : n;
  if (p.pixels.length > 0) fetchAndUpdatePixelPlot(panelId);
}

function addPixelToPanel(panelId, row, col) {
  const p = panels.get(panelId);
  if (!p) return;
  if (p.pixels.length >= MAX_PIXELS) { showToast(`Max ${MAX_PIXELS} pixels. Clear some first.`); return; }
  p.pixels.push({ row, col, color: PIXEL_COLORS[p.pixels.length] });
  showPixelExplorer(panelId);
  updatePixelChips(panelId);
  renderZoomed(panelId);
  if (p.isComparison) renderZoomed2(panelId);
  fetchAndUpdatePixelPlot(panelId);
}

function removePixel(panelId, index) {
  const p = panels.get(panelId);
  if (!p) return;
  p.pixels.splice(index, 1);
  p.pixels.forEach((px, i) => { px.color = PIXEL_COLORS[i]; });
  p.pixelPlotInited = false;
  updatePixelChips(panelId);
  renderZoomed(panelId);
  if (p.isComparison) renderZoomed2(panelId);
  if (p.pixels.length === 0) {
    const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
    if (chartDiv) { try { Plotly.purge(chartDiv); } catch {} chartDiv.innerHTML = ''; }
  } else {
    fetchAndUpdatePixelPlot(panelId);
  }
}

function clearAllPixels(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  p.pixels = []; p.pixelPlotInited = false;
  updatePixelChips(panelId);
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (chartDiv) { try { Plotly.purge(chartDiv); } catch {} chartDiv.innerHTML = ''; }
  renderZoomed(panelId);
  if (p.isComparison) renderZoomed2(panelId);
}

// Clears the active explorer content (pixels or row/col slice) based on current mode
function clearPixelExplorer(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  if (p.explorerMode === 'pixel') {
    clearAllPixels(panelId);
  } else {
    p.sliceIndex = -1;
    const lbl = document.getElementById(`exp-slice-label-${panelId}`);
    if (lbl) lbl.textContent = '';
    const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
    if (chartDiv) { try { Plotly.purge(chartDiv); } catch {} chartDiv.innerHTML = ''; }
    renderZoomed(panelId);
  }
}

function setExplorerMode(panelId, mode) {
  const p = panels.get(panelId);
  if (!p) return;
  p.explorerMode = mode;

  // Update button active state
  ['pixel', 'row', 'col'].forEach(m => {
    const btn = document.getElementById(`exp-mode-${m}-${panelId}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });

  // Clear previous explorer content when switching modes
  p.pixels = []; p.pixelPlotInited = false;
  p.sliceIndex = -1;
  updatePixelChips(panelId);
  const lbl = document.getElementById(`exp-slice-label-${panelId}`);
  if (lbl) lbl.textContent = '';
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (chartDiv) { try { Plotly.purge(chartDiv); } catch {} chartDiv.innerHTML = ''; }
  renderZoomed(panelId);
}

function setVideoSlice(panelId, index) {
  const p = panels.get(panelId);
  if (!p) return;
  p.sliceIndex = index;
  const lbl = document.getElementById(`exp-slice-label-${panelId}`);
  if (lbl) lbl.textContent = `${p.explorerMode}=${index}`;
  showPixelExplorer(panelId);
  renderZoomed(panelId);  // redraws marker
  fetchAndUpdateVideoSlice(panelId);
}

function drawVideoSliceMarker(panelId) {
  const p = panels.get(panelId);
  if (!p || p.sliceIndex < 0) return;
  const canvas = document.getElementById(`panel-canvas-${panelId}`);
  if (!canvas) return;
  const lb = getLetterboxRect(panelId);
  if (!lb) return;
  const { x0, y0, x1, y1 } = p.zoom;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 220, 50, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  if (p.explorerMode === 'row') {
    const fy = (p.sliceIndex + 0.5 - y0) / (y1 - y0);
    const sy = lb.dstY + fy * lb.dstH;
    if (sy < lb.dstY - 2 || sy > lb.dstY + lb.dstH + 2) { ctx.restore(); return; }
    const bandH = Math.max(2, lb.dstH / (y1 - y0));
    ctx.fillStyle = 'rgba(255, 220, 50, 0.2)';
    ctx.fillRect(lb.dstX, sy - bandH / 2, lb.dstW, bandH);
    ctx.beginPath(); ctx.moveTo(lb.dstX, sy); ctx.lineTo(lb.dstX + lb.dstW, sy); ctx.stroke();
  } else {
    const fx = (p.sliceIndex + 0.5 - x0) / (x1 - x0);
    const sx = lb.dstX + fx * lb.dstW;
    if (sx < lb.dstX - 2 || sx > lb.dstX + lb.dstW + 2) { ctx.restore(); return; }
    const bandW = Math.max(2, lb.dstW / (x1 - x0));
    ctx.fillStyle = 'rgba(255, 220, 50, 0.2)';
    ctx.fillRect(sx - bandW / 2, lb.dstY, bandW, lb.dstH);
    ctx.beginPath(); ctx.moveTo(sx, lb.dstY); ctx.lineTo(sx, lb.dstY + lb.dstH); ctx.stroke();
  }
  ctx.restore();
}

async function fetchAndUpdateVideoSlice(panelId) {
  const p = panels.get(panelId);
  if (!p || p.sliceIndex < 0 || p.explorerMode === 'pixel') return;
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (!chartDiv) return;

  const axis = p.explorerMode;  // 'row' or 'col'
  const frame = p.currentFrame;
  const component = p.settings.component;
  let data;
  try {
    data = await apiJSON(
      `/api/variable/${p.varName}/video-spatial-slice?axis=${axis}&index=${p.sliceIndex}&frame=${frame}&component=${component}`
    );
  } catch (e) { console.error('video spatial slice fetch error', e); return; }

  let data2 = null;
  if (p.isComparison && p.varName2) {
    try {
      data2 = await apiJSON(
        `/api/variable/${p.varName2}/video-spatial-slice?axis=${axis}&index=${p.sliceIndex}&frame=${Math.min(frame, p.frameCount2 - 1)}&component=${component}`
      );
    } catch (e) { console.error('video spatial slice fetch error (var2)', e); }
  }

  const scale = commonScale !== null ? commonScale : 1;
  const x = Array.from({length: data.length}, (_, i) => i);
  const xLabel = axis === 'row' ? 'col index' : 'row index';
  const yLabel = commonScale !== null ? 'ADU (scaled)' : 'value';

  const traces = [];
  const color = PIXEL_COLORS[0];
  const v1suffix = data2 ? ` (${p.varName})` : '';
  const v2suffix = data2 ? ` (${p.varName2})` : '';
  const label = `${axis}=${data.index} frame=${data.frame}`;

  if (data.is_complex && p.pixelPlotMode === 'ri') {
    traces.push({ x, y: data.real.map(v => v * scale),  name: `Re ${label}${v1suffix}`, type: 'scatter', mode: 'lines', line: { color, width: 1 } });
    traces.push({ x, y: data.imag.map(v => v * scale),  name: `Im ${label}${v1suffix}`, type: 'scatter', mode: 'lines', line: { color, width: 1 } });
    if (data2) {
      const x2 = Array.from({length: data2.length}, (_, i) => i);
      traces.push({ x: x2, y: data2.real.map(v => v * scale),  name: `Re ${label}${v2suffix}`, type: 'scatter', mode: 'lines', line: { color: PIXEL_COLORS[1], width: 1 } });
      traces.push({ x: x2, y: data2.imag.map(v => v * scale),  name: `Im ${label}${v2suffix}`, type: 'scatter', mode: 'lines', line: { color: PIXEL_COLORS[1], width: 1 } });
    }
  } else {
    traces.push({ x, y: data.magnitude.map(v => v * scale), name: label + v1suffix, type: 'scatter', mode: 'lines', line: { color, width: 1 } });
    if (data2) {
      const x2 = Array.from({length: data2.length}, (_, i) => i);
      traces.push({ x: x2, y: data2.magnitude.map(v => v * scale), name: label + v2suffix, type: 'scatter', mode: 'lines', line: { color: PIXEL_COLORS[1], width: 1 } });
    }
  }

  const layout = {
    paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1a1a1a',
    font: { color: '#cccccc', size: 9 },
    margin: { t: 4, r: 8, b: 28, l: 48 },
    xaxis: { gridcolor: '#333', zerolinecolor: '#444',
             title: { text: xLabel, font: { size: 9 } } },
    yaxis: { gridcolor: '#333', zerolinecolor: '#444',
             title: { text: yLabel, font: { size: 9 } } },
    showlegend: data.is_complex || !!data2,
    legend: { font: { size: 9 }, orientation: 'h', y: -0.35 },
    dragmode: 'pan',
    autosize: true,
  };
  const opts = { responsive: true, displayModeBar: true, scrollZoom: true,
                 displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d', 'toImage'] };
  if (p.pixelPlotInited) {
    Plotly.react(chartDiv, traces, layout, opts);
  } else {
    Plotly.newPlot(chartDiv, traces, layout, opts);
    p.pixelPlotInited = true;
  }
}

function updatePixelChips(panelId) {
  const container = document.getElementById(`pixel-chips-${panelId}`);
  const p = panels.get(panelId);
  if (!container || !p) return;
  container.innerHTML = p.pixels.map((px, i) => `
    <span class="pixel-chip" style="border-color:${px.color}">
      <span class="pixel-chip-dot" style="background:${px.color}"></span>
      ${px.row},${px.col}
      <button class="pixel-chip-x" onclick="removePixel('${panelId}',${i})" title="Remove">✕</button>
    </span>`).join('');
}

async function fetchAndUpdatePixelPlot(panelId) {
  const p = panels.get(panelId);
  if (!p || p.pixels.length === 0) return;
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (!chartDiv) return;

  let allData, allData2 = null;
  try {
    allData = await Promise.all(
      p.pixels.map(px => apiJSON(`/api/variable/${p.varName}/pixel-series?row=${px.row}&col=${px.col}`))
    );
  } catch (e) { console.error('pixel series fetch error', e); return; }
  if (p.isComparison && p.varName2) {
    try {
      allData2 = await Promise.all(
        p.pixels.map(px => apiJSON(`/api/variable/${p.varName2}/pixel-series?row=${px.row}&col=${px.col}`))
      );
    } catch (e) { console.error('pixel series fetch error (var2)', e); }
  }

  const isComplex = allData[0].is_complex;
  const fullLen = allData[0].length;
  const xMax = (p.pixelPlotXMax != null) ? Math.min(p.pixelPlotXMax, fullLen) : fullLen;
  const x = Array.from({length: xMax}, (_, i) => i);
  const yLabel = commonScale !== null ? 'ADU (scaled)' : 'value';

  // Helper: clip array to xMax
  const clip = arr => arr ? arr.slice(0, xMax) : arr;

  const traces = [];

  if (isComplex) {
    // Two vertically-stacked subplots sharing x-axis
    const topLabel = p.pixelPlotMode === 'ri' ? 'real' : 'magnitude';
    const botLabel = p.pixelPlotMode === 'ri' ? 'imaginary' : 'phase (rad)';

    for (let i = 0; i < p.pixels.length; i++) {
      const { color } = p.pixels[i];
      const line1 = allData2 ? {color, width:1, dash:'dash'} : {color, width:1};
      const line1opacity = allData2 ? 0.7 : 1;
      const d = allData[i];
      const label = `${d.row},${d.col}`;
      const v1suffix = allData2 ? ` (${p.varName})` : '';
      const v2suffix = allData2 ? ` (${p.varName2})` : '';

      if (p.pixelPlotMode === 'ri') {
        traces.push({ x, y: clip(unnorm(d.real,'real')),  name:`${label} Re${v1suffix}`, type:'scatter', mode:'lines', line:line1, opacity:line1opacity, xaxis:'x', yaxis:'y' });
        traces.push({ x, y: clip(unnorm(d.imag,'imag')),  name:`${label} Im${v1suffix}`, type:'scatter', mode:'lines', line:line1, opacity:line1opacity, xaxis:'x2', yaxis:'y2' });
        if (allData2) {
          const d2 = allData2[i];
          const x2len = (p.pixelPlotXMax != null) ? Math.min(p.pixelPlotXMax, d2.length) : d2.length;
          const x2 = Array.from({length:x2len},(_,j)=>j);
          traces.push({ x:x2, y: clip(unnorm(d2.real,'real')),  name:`${label} Re${v2suffix}`, type:'scatter', mode:'lines', line:{color, width:1}, xaxis:'x', yaxis:'y' });
          traces.push({ x:x2, y: clip(unnorm(d2.imag,'imag')),  name:`${label} Im${v2suffix}`, type:'scatter', mode:'lines', line:{color, width:1}, xaxis:'x2', yaxis:'y2' });
        }
      } else {
        traces.push({ x, y: clip(unnorm(d.magnitude,'magnitude')), name:`${label} |z|${v1suffix}`, type:'scatter', mode:'lines', line:line1, opacity:line1opacity, xaxis:'x', yaxis:'y' });
        traces.push({ x, y: clip(unnorm(d.phase,'phase')),         name:`${label} ∠${v1suffix}`,   type:'scatter', mode:'lines', line:line1, opacity:line1opacity, xaxis:'x2', yaxis:'y2' });
        if (allData2) {
          const d2 = allData2[i];
          const x2len = (p.pixelPlotXMax != null) ? Math.min(p.pixelPlotXMax, d2.length) : d2.length;
          const x2 = Array.from({length:x2len},(_,j)=>j);
          traces.push({ x:x2, y: clip(unnorm(d2.magnitude,'magnitude')), name:`${label} |z|${v2suffix}`, type:'scatter', mode:'lines', line:{color, width:1}, xaxis:'x', yaxis:'y' });
          traces.push({ x:x2, y: clip(unnorm(d2.phase,'phase')),         name:`${label} ∠${v2suffix}`,   type:'scatter', mode:'lines', line:{color, width:1}, xaxis:'x2', yaxis:'y2' });
        }
      }
    }

    const layout = {
      paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1a1a1a',
      font: { color: '#cccccc', size: 9 },
      margin: { t: 4, r: 8, b: 36, l: 48 },
      xaxis:  { domain: [0, 1], anchor: 'y',  gridcolor: '#333', zerolinecolor: '#444', showticklabels: false, matches: 'x2' },
      yaxis:  { domain: [0.53, 1.0], anchor: 'x',  gridcolor: '#333', zerolinecolor: '#444', title: { text: topLabel, font: { size: 9 } } },
      xaxis2: { domain: [0, 1], anchor: 'y2', gridcolor: '#333', zerolinecolor: '#444', title: { text: 'index', font: { size: 9 } } },
      yaxis2: { domain: [0.0, 0.47], anchor: 'x2', gridcolor: '#333', zerolinecolor: '#444', title: { text: botLabel, font: { size: 9 } } },
      showlegend: p.pixels.length > 1 || !!allData2,
      legend: { font: { size: 9 }, orientation: 'h', y: -0.18 },
      dragmode: 'pan',
      autosize: true,
    };
    const opts = { responsive: true, displayModeBar: true, scrollZoom: true,
                   displaylogo: false, modeBarButtonsToRemove: ['select2d','lasso2d','toImage'] };
    if (p.pixelPlotInited) {
      Plotly.react(chartDiv, traces, layout, opts);
    } else {
      Plotly.newPlot(chartDiv, traces, layout, opts);
      p.pixelPlotInited = true;
    }
  } else {
    // Non-complex: single subplot
    for (let i = 0; i < p.pixels.length; i++) {
      const { color } = p.pixels[i];
      const line1 = allData2 ? {color, width:1, dash:'dash'} : {color, width:1};
      const line1opacity = allData2 ? 0.7 : 1;
      const d = allData[i];
      const label = `${d.row},${d.col}`;
      const v1suffix = allData2 ? ` (${p.varName})` : '';
      const v2suffix = allData2 ? ` (${p.varName2})` : '';
      traces.push({ x, y: clip(unnorm(d.magnitude,'magnitude')), name: label + v1suffix, type:'scatter', mode:'lines', line:line1, opacity:line1opacity });
      if (allData2) {
        const d2 = allData2[i];
        const x2len = (p.pixelPlotXMax != null) ? Math.min(p.pixelPlotXMax, d2.length) : d2.length;
        traces.push({ x: Array.from({length:x2len},(_,j)=>j), y: clip(unnorm(d2.magnitude,'magnitude')), name: label + v2suffix, type:'scatter', mode:'lines', line:{color, width:1} });
      }
    }
    const layout = {
      paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1a1a1a',
      font: { color: '#cccccc', size: 9 },
      margin: { t: 4, r: 8, b: 28, l: 48 },
      xaxis: { gridcolor: '#333', zerolinecolor: '#444' },
      yaxis: { gridcolor: '#333', zerolinecolor: '#444', title: { text: yLabel, font: { size: 9 } } },
      showlegend: p.pixels.length > 1 || !!allData2,
      legend: { font: { size: 9 }, orientation: 'h', y: -0.35 },
      dragmode: 'pan',
      autosize: true,
    };
    const opts = { responsive: true, displayModeBar: true, scrollZoom: true,
                   displaylogo: false, modeBarButtonsToRemove: ['select2d','lasso2d','toImage'] };
    if (p.pixelPlotInited) {
      Plotly.react(chartDiv, traces, layout, opts);
    } else {
      Plotly.newPlot(chartDiv, traces, layout, opts);
      p.pixelPlotInited = true;
    }
  }
}

// ---- Heatmap Slice ----
function toggleSliceAxis(panelId) {
  const p = panels.get(panelId);
  if (!p) return;
  p.sliceAxis = (p.sliceAxis === 'row') ? 'col' : 'row';
  const btn = document.getElementById(`slice-axis-${panelId}`);
  if (btn) btn.textContent = p.sliceAxis === 'row' ? 'Row' : 'Col';
  if (p.sliceIndex >= 0) {
    if (p.isComparison) { renderZoomed(panelId); renderZoomed2(panelId); }
    else drawHeatmapMarker(panelId);
    fetchAndUpdateHeatmapSlice(panelId);
  }
}

function stepSlice(panelId, delta) {
  const p = panels.get(panelId);
  if (!p) return;
  const idx = Math.max(0, (p.sliceIndex < 0 ? 0 : p.sliceIndex) + delta);
  setHeatmapSlice(panelId, idx);
}

function drawHeatmapMarker(panelId) {
  const p = panels.get(panelId);
  const markerCanvas = document.getElementById(`panel-marker-${panelId}`);
  if (!markerCanvas) return;

  // Match marker pixel dimensions to its CSS display size
  const cw = markerCanvas.clientWidth, ch = markerCanvas.clientHeight;
  if (!cw || !ch) return;
  if (markerCanvas.width !== cw || markerCanvas.height !== ch) {
    markerCanvas.width = cw; markerCanvas.height = ch;
  }
  const ctx = markerCanvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);

  if (!p || p.sliceIndex < 0 || !p.offscreenCanvas) return;

  // Get letterbox rect so marker aligns with actual image area
  const lb = getLetterboxRect(panelId);
  if (!lb) return;

  const { x0, y0, x1, y1 } = p.zoom;
  const BAND_COLOR = 'rgba(255, 220, 50, 0.25)';
  const LINE_COLOR = 'rgba(255, 220, 50, 0.9)';

  ctx.save();
  ctx.strokeStyle = LINE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  if (p.sliceAxis === 'row') {
    const fy = (p.sliceIndex + 0.5 - y0) / (y1 - y0);
    const sy = lb.dstY + fy * lb.dstH;
    if (sy < lb.dstY - 2 || sy > lb.dstY + lb.dstH + 2) { ctx.restore(); return; }
    const bandH = Math.max(2, lb.dstH / (y1 - y0));
    ctx.fillStyle = BAND_COLOR;
    ctx.fillRect(lb.dstX, sy - bandH / 2, lb.dstW, bandH);
    ctx.beginPath(); ctx.moveTo(lb.dstX, sy); ctx.lineTo(lb.dstX + lb.dstW, sy); ctx.stroke();
  } else {
    const fx = (p.sliceIndex + 0.5 - x0) / (x1 - x0);
    const sx = lb.dstX + fx * lb.dstW;
    if (sx < lb.dstX - 2 || sx > lb.dstX + lb.dstW + 2) { ctx.restore(); return; }
    const bandW = Math.max(2, lb.dstW / (x1 - x0));
    ctx.fillStyle = BAND_COLOR;
    ctx.fillRect(sx - bandW / 2, lb.dstY, bandW, lb.dstH);
    ctx.beginPath(); ctx.moveTo(sx, lb.dstY); ctx.lineTo(sx, lb.dstY + lb.dstH); ctx.stroke();
  }
  ctx.restore();
}

function setHeatmapSlice(panelId, index) {
  const p = panels.get(panelId);
  if (!p) return;
  p.sliceIndex = index;
  const lbl = document.getElementById(`slice-idx-label-${panelId}`);
  if (lbl) lbl.textContent = `${p.sliceAxis}=${index}`;
  showPixelExplorer(panelId);
  if (p.isComparison) {
    renderZoomed(panelId);
    renderZoomed2(panelId);
  } else {
    drawHeatmapMarker(panelId);
  }
  fetchAndUpdateHeatmapSlice(panelId);
}

async function fetchAndUpdateHeatmapSlice(panelId) {
  const p = panels.get(panelId);
  if (!p || p.sliceIndex < 0) return;
  const chartDiv = document.getElementById(`pixel-chart-${panelId}`);
  if (!chartDiv) return;

  let data, data2 = null;
  try {
    data = await apiJSON(
      `/api/variable/${p.varName}/heatmap-slice?axis=${p.sliceAxis}&index=${p.sliceIndex}&component=${p.settings.component}`
    );
  } catch (e) { console.error('heatmap slice error', e); return; }
  if (p.isComparison && p.varName2) {
    try {
      // Slice index is in var1 space; scale to var2 space if dimensions differ
      const W1 = p.offscreenCanvas?.width, H1 = p.offscreenCanvas?.height;
      const W2 = p.offscreenCanvas2?.width, H2 = p.offscreenCanvas2?.height;
      let idx2 = p.sliceIndex;
      if (W1 && H1 && W2 && H2) {
        idx2 = p.sliceAxis === 'row' ? Math.round(p.sliceIndex * H2 / H1) : Math.round(p.sliceIndex * W2 / W1);
      }
      data2 = await apiJSON(
        `/api/variable/${p.varName2}/heatmap-slice?axis=${p.sliceAxis}&index=${idx2}&component=${p.settings.component}`
      );
    } catch (e) { console.error('heatmap slice error (var2)', e); }
  }

  const scale = commonScale !== null ? commonScale : 1;
  const y1vals = data.values.map(v => v * scale);
  const x1 = Array.from({length: y1vals.length}, (_, i) => i);
  const yLabel = commonScale !== null ? 'ADU (scaled)' : 'value';
  const xLabel = p.sliceAxis === 'row' ? 'col index' : 'row index';

  const traces = [
    { x: x1, y: y1vals, type: 'scatter', mode: 'lines',
      name: data2 ? p.varName : undefined,
      line: { color: PIXEL_COLORS[0], width: 1 } },
  ];
  if (data2) {
    const y2vals = data2.values.map(v => v * scale);
    const x2 = Array.from({length: y2vals.length}, (_, i) => i);
    traces.push({ x: x2, y: y2vals, type: 'scatter', mode: 'lines',
      name: p.varName2, line: { color: PIXEL_COLORS[1], width: 1 } });
  }

  const layout = {
    paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1a1a1a',
    font: { color: '#cccccc', size: 9 },
    margin: { t: 4, r: 8, b: 28, l: 48 },
    xaxis: { gridcolor: '#333', zerolinecolor: '#444',
             title: { text: xLabel, font: { size: 9 } } },
    yaxis: { gridcolor: '#333', zerolinecolor: '#444',
             title: { text: yLabel, font: { size: 9 } } },
    showlegend: !!data2,
    legend: { font: { size: 9 }, orientation: 'h', y: -0.35 },
    dragmode: 'pan', autosize: true,
  };
  const opts = { responsive: true, displayModeBar: true, scrollZoom: true,
                 displaylogo: false, modeBarButtonsToRemove: ['select2d','lasso2d','toImage'] };
  if (p.pixelPlotInited) {
    Plotly.react(chartDiv, traces, layout, opts);
  } else {
    Plotly.newPlot(chartDiv, traces, layout, opts);
    p.pixelPlotInited = true;
  }
}

// ---- Export panel data as NPY ----
async function exportPanelAsNpy(panelId) {
  const p = panels.get(panelId);
  if (!p) return;

  // For comparison panels export both variables sequentially
  const targets = p.isComparison
    ? [{ varName: p.varName }, { varName: p.varName2 }]
    : [{ varName: p.varName }];

  for (const { varName } of targets) {
    const defaultName = varName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = prompt('Filename (without extension):', defaultName);
    if (name === null) return;  // cancelled

    const filename = (name.trim() || defaultName) + '.npy';
    const params = new URLSearchParams({
      frame_index: String(p.currentFrame || 0),
      component: p.settings.component || 'magnitude',
      ref_frame: p.settings.refFrame || 'none',
      subtract_rowcol_mean: p.settings.subtractRowColMean || false,
    });

    try {
      const resp = await apiFetch(
        `/api/variable/${encodeURIComponent(varName)}/frame-npy?${params}`
      );
      const blob = new Blob([await resp.arrayBuffer()], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Saved ${filename}`);
    } catch (e) {
      showToast('NPY export failed: ' + e.message);
      return;
    }
  }
}

// ---- Export panel as MP4 (uses current display settings: cmap/clahe/limits/etc) ----
async function exportPanelAsMp4(panelId) {
  const p = panels.get(panelId);
  if (!p || p.renderType !== 'video') return;

  const defaultName = p.varName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const name = prompt('Filename (without extension):', defaultName);
  if (name === null) return;
  const filename = (name.trim() || defaultName) + '.mp4';

  const fpsInput = prompt('Frames per second:', '15');
  if (fpsInput === null) return;
  const fps = parseFloat(fpsInput) || 15;

  const { cmap, pmin, pmax, component, clahe, histeq = false, refFrame = 'none',
          subtractRowColMean = false, isocontourRange = 1, derivative = 'none',
          derivSigmaS = 1.0, derivSigmaT = 1.0 } = p.settings;
  const params = new URLSearchParams({
    cmap, pmin, pmax, component,
    clahe: clahe ? 'true' : 'false',
    histeq: histeq ? 'true' : 'false',
    ref_frame: refFrame,
    subtract_rowcol_mean: subtractRowColMean ? 'true' : 'false',
    isocontour_range: isocontourRange,
    fps,
  });
  if (component === 'phase') { params.set('vmin', -Math.PI); params.set('vmax', Math.PI); }
  if (derivative !== 'none') {
    params.set('derivative', derivative);
    params.set('deriv_sigma_s', derivSigmaS);
    params.set('deriv_sigma_t', derivSigmaT);
  }
  // Crop to the panel's current zoom/pan viewport, matching the PNG export.
  if (p.zoom && isFinite(p.zoom.x0) && isFinite(p.zoom.x1) && (p.zoom.x1 - p.zoom.x0) > 0) {
    params.set('crop_x0', p.zoom.x0);
    params.set('crop_y0', p.zoom.y0);
    params.set('crop_x1', p.zoom.x1);
    params.set('crop_y1', p.zoom.y1);
  }
  if (p.flipH) params.set('flip_h', 'true');

  showToast(`Rendering ${filename}… this may take a while`);
  try {
    const resp = await apiFetch(`/api/variable/${encodeURIComponent(p.varName)}/export-mp4?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Saved ${filename}`);
  } catch (e) {
    showToast('MP4 export failed: ' + e.message);
  }
}

// ---- Export panel as PNG ----
// For video/heatmap/image panels, renders server-side at full source resolution
// cropped to the panel's current zoom rect (matches exportPanelAsMp4), avoiding
// the upscaling/interpolation artifacts of grabbing the on-screen canvas.
async function exportPanelAsPNG(panelId) {
  const p = panels.get(panelId);
  if (!p) return;

  const defaultName = (p.isComparison
    ? `${p.varName}_vs_${p.varName2}`
    : p.varName
  ).replace(/[^a-zA-Z0-9_-]/g, '_');

  const name = prompt('Filename (without extension):', defaultName);
  if (name === null) return;
  const baseName = name.trim() || defaultName;

  function triggerDownload(dataURL, dlFilename) {
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = dlFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // Crop a canvas to its letterbox content rect and return a data URL.
  function cropToLetterbox(canvas, lb) {
    if (!lb) return canvas.toDataURL('image/png');
    const { dstX, dstY, dstW, dstH } = lb;
    const w = Math.round(dstW), h = Math.round(dstH);
    if (w <= 0 || h <= 0) return canvas.toDataURL('image/png');
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(canvas, Math.round(dstX), Math.round(dstY), w, h, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  }

  function buildExportParams(varName2 = false) {
    const { cmap, pmin, pmax, component, clahe, histeq = false, refFrame = 'none',
            subtractRowColMean = false, isocontourRange = 1, derivative = 'none',
            derivSigmaS = 1.0, derivSigmaT = 1.0 } = p.settings;
    const params = new URLSearchParams({
      cmap, pmin, pmax, component,
      clahe: clahe ? 'true' : 'false',
      histeq: histeq ? 'true' : 'false',
      ref_frame: refFrame,
      subtract_rowcol_mean: subtractRowColMean ? 'true' : 'false',
      isocontour_range: isocontourRange,
    });
    if (component === 'phase') { params.set('vmin', -Math.PI); params.set('vmax', Math.PI); }
    if (derivative !== 'none') {
      params.set('derivative', derivative);
      params.set('deriv_sigma_s', derivSigmaS);
      params.set('deriv_sigma_t', derivSigmaT);
    }
    if (p.renderType === 'video') params.set('frame_index', p.currentFrame || 0);
    if (p.flipH) params.set('flip_h', 'true');
    if (p.zoom && isFinite(p.zoom.x0) && isFinite(p.zoom.x1) && (p.zoom.x1 - p.zoom.x0) > 0) {
      if (!varName2) {
        params.set('crop_x0', p.zoom.x0);
        params.set('crop_y0', p.zoom.y0);
        params.set('crop_x1', p.zoom.x1);
        params.set('crop_y1', p.zoom.y1);
      } else {
        // Scale the shared zoom rect (var1 coordinate space) into var2's space.
        const { x0, y0, x1, y1 } = p.zoom;
        const W1 = p.offscreenCanvas?.width  || (x1 - x0);
        const H1 = p.offscreenCanvas?.height || (y1 - y0);
        const W2 = p.offscreenCanvas2?.width  || W1;
        const H2 = p.offscreenCanvas2?.height || H1;
        const scaleX = W2 / W1, scaleY = H2 / H1;
        params.set('crop_x0', x0 * scaleX);
        params.set('crop_y0', y0 * scaleY);
        params.set('crop_x1', x1 * scaleX);
        params.set('crop_y1', y1 * scaleY);
      }
    }
    return params;
  }

  async function fetchAndDownloadPng(varName, params, dlFilename) {
    const resp = await apiFetch(`/api/variable/${encodeURIComponent(varName)}/export-png?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    triggerDownload(url, dlFilename);
    URL.revokeObjectURL(url);
  }

  try {
    const rt = p.renderType;
    if (rt === 'video' || rt === 'heatmap' || rt === 'image') {
      if (p.isComparison) {
        await fetchAndDownloadPng(p.varName, buildExportParams(false), baseName + '_left.png');
        await fetchAndDownloadPng(p.varName2, buildExportParams(true), baseName + '_right.png');
        showToast(`Saved ${baseName}_left.png and ${baseName}_right.png`);
      } else {
        await fetchAndDownloadPng(p.varName, buildExportParams(false), baseName + '.png');
        showToast(`Saved ${baseName}.png`);
      }
      return;
    } else if (rt === 'line' || rt === 'barchart') {
      const plotDiv = document.getElementById(`panel-plot-${panelId}`);
      if (!plotDiv) return;
      const dataURL = await Plotly.toImage(plotDiv, {
        format: 'png',
        width: plotDiv.offsetWidth || 800,
        height: plotDiv.offsetHeight || 500,
      });
      triggerDownload(dataURL, baseName + '.png');
      showToast(`Saved ${baseName}.png`);
      return;
    } else {
      return;
    }
  } catch (e) {
    showToast('PNG export failed: ' + e.message);
    return;
  }
}

// ---- Bootstrap ----
window.addEventListener('DOMContentLoaded', init);
