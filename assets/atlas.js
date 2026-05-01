// Atlas SPA — vanilla JS, virtualized table + per-feature view.

const STATE = {
  index: null,
  D: 0,
  steps: [],
  // typed-array views over feature scalars (built on load)
  arrs: {},
  // current sort/filter state
  view: [], // Int32Array of feature ids in current order
  sortKey: 'step1000_norm_delta',
  sortDir: -1, // -1 desc, 1 asc — biggest gainers across the step-1000 window first
  filters: {
    lifecycle: '',
    aliveAtEnd: '',
    minPeakStep: null,
    maxPeakStep: null,
    minRateTerm: null,
    tokenSubstr: '',
    concept: '',
  },
  shardCache: new Map(),
};

const COLS = [
  { key: 'id', label: 'feat', w: 60, fmt: v => v.toString() },
  { key: 'lifecycle', label: 'lifecycle', w: 130, fmt: v => v, cls: v => 'lifecycle lc-' + v },
  { key: 'peak_step', label: 'peak step', w: 80, fmt: v => v.toLocaleString(), num: true },
  { key: 'step1000_norm_delta', label: 'Δ‖·‖ @1k', w: 90, fmt: v => signed(v, 3), num: true,
    cls: v => 'num delta ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') },
  { key: 'first_active_step', label: 'first active', w: 90, fmt: v => v < 0 ? '—' : v.toLocaleString(), num: true },
  { key: 'lifetime_snaps', label: 'life', w: 50, fmt: v => v.toString(), num: true },
  { key: 'rate_terminal', label: 'rate(T)', w: 75, fmt: v => fmtPct(v), num: true },
  { key: 'norm_terminal', label: '‖W_D‖(T)', w: 80, fmt: v => v.toFixed(3), num: true },
  { key: 'cusum_rotation', label: 'CUSUM rot', w: 90, fmt: v => v.toFixed(2), num: true },
  { key: 'top5_token', label: 'top tokens (T)', w: 'minmax(220px, 1.5fr)', fmt: v => v, cls: () => 'tok' },
  { key: 'concept_top1', label: 'concept', w: 'minmax(140px, 0.7fr)', fmt: () => '',
    cls: () => 'concept empty' },
];

const ROW_H = 26;

function fmtPct(v) {
  if (v < 1e-5) return '0';
  if (v < 0.001) return (v * 1e6).toFixed(0) + 'e-6';
  return (v * 100).toFixed(2) + '%';
}

// Hand-curated interpretable features. Edit freely.
const EXAMPLES = [
  {
    title: 'Step-1000-emergent (paper-headline window)',
    note: "Controlled vocabulary families becoming legible around the [256, 1000] transition window. These are the kind of features the paper's Sec. 4–5 motivate.",
    items: [
      { id: 24306, caption: 'sentence-initial discourse markers', detail: "Already coherent at step 512 (`However · Another · Accordingly · Similarly · Moreover · Therefore · Furthermore · Thus`) and tightens further by terminal." },
      { id: 20620, caption: 'all-caps suffix fragments', detail: "At step 512: `ATION · IES · ATIONS · ATE · ELY · ING · IAL · OULD`. Swaps to a different family of caps tails by terminal." },
      { id: 10247, caption: 'abstract -ity / -ness quality nouns', detail: '`clarity · completeness · simplicity · purity · complexity · robustness · seriousness · richness`. A clean abstract-noun cluster crystallized at peak step 5000.' },
      { id: 2930, caption: 'product-category nouns', detail: '`food · music · clothing · equipment · hardware · furniture`. Clean concrete-category cluster, peak step 9000.' },
    ],
  },
  {
    title: 'Multilingual & non-Latin scripts',
    note: 'The paper highlights multi-script tokens as visible in transition features. The crosscoder discovers script-specialized features at every level — bare characters, sub-syllables, morphological endings, and conjugated verb stems.',
    items: [
      { id: 11101, caption: 'Russian noun/adjective endings', detail: '`ий · ое · ия · ии · ие · ому · ого · ый` — gender/case morphology. Step-1000-emergent, peak step 3000.' },
      { id: 6745, caption: 'Cyrillic CV-syllables (а-prefix)', detail: '`ан · а · ав · ат · ад · аб · ас · ал` — sub-syllabic Russian fragments.' },
      { id: 11897, caption: 'Japanese する verb conjugations', detail: '`した · している · して · する · します · された · され · し` — full past/present/passive paradigm of "do".' },
      { id: 419, caption: 'Japanese demonstratives (こそあど)', detail: '`あ · こ · そ · これ · この · よ · その · それ` — Japanese demonstrative pronoun system.' },
      { id: 18810, caption: 'Chinese function words', detail: '`无 · 对 · 我们 · 为 · 请 · 这 · 将 · 设` — Chinese pronouns, prepositions, modals.' },
      { id: 12684, caption: 'Arabic letters & function words', detail: '`ف · ق · خ · ر · س · ح · ات · من`.' },
      { id: 17328, caption: 'Greek mathematical letters', detail: '`ω · β · α · μ · ϕ · ψ` — purely the math-Greek inventory. Late-emergent at step 143k — the Greek-letter math feature crystallizes at the very end.' },
      { id: 23884, caption: 'Modern Greek morphological endings', detail: '`εν · ού · αν · ον · ου · ει · άν · η`.' },
      { id: 17379, caption: 'Hebrew consonants', detail: '`ל · ע · ר · ב · פ · ש · מ`.' },
      { id: 20545, caption: 'Devanagari consonants', detail: '`त · ह · क · व · द · स · य · न`.' },
    ],
  },
  {
    title: 'Math, LaTeX & equation context',
    note: 'Backslash-heavy LaTeX command and delimiter features — common in arXiv-style math content. All persistent, peaking deep into training.',
    items: [
      { id: 219, caption: 'LaTeX expression closers', detail: '`}}\\ · )\\ · \')\\ · )\\,\\ · ]\\` — closing punctuation around math expressions.' },
      { id: 12722, caption: 'subscript/superscript braces', detail: '`}_{ · )}_{ · }_{ · )}_{\\ · }}_{ · }_{\\` — subscript-attachment patterns.' },
      { id: 13744, caption: 'norm / absolute-value bars', detail: '`\\|\\ · \\|\\ · \\| · |\\ · $\\|\\ · }\\|` — math-mode `|·|` delimiters.' },
    ],
  },
  {
    title: 'Years & decades (and other digit features)',
    note: 'Numeric features the model crystallizes deep into training. Different decades occupy different features — clean evidence of "decade-bin" specialization.',
    items: [
      { id: 18990, caption: '2010s years', detail: '`2018 · 2017 · 2019 · 2018 · 2016 · 2019 · Instagram · 2017`. Peak step 116k, late-emergent.' },
      { id: 10271, caption: '1990s years', detail: '`1996 · 1995 · 1994 · 1997 · 1995 · 1998 · 1996 · 1993`. Peak step 116k.' },
      { id: 22183, caption: '1930s years', detail: '`1934 · 1932 · 1933 · 1935 · 1931 · 1934 · 1933 · 1932`. Persistent — a 1930s-specialized direction.' },
      { id: 24378, caption: 'numbers ending in 6', detail: '`286, 206, 446, 266, 146, 406, 106, …` — last-digit-6 detector.' },
      { id: 22217, caption: '99x range', detail: '`995, 959, 999, 997, 990, 996, 998, 991, 989`.' },
      { id: 23282, caption: '05x decade', detail: '`059, 055, 052, 056, 053, 058, 057 …`. Random/garbled at step 512; perfectly specialized at terminal.' },
    ],
  },
  {
    title: 'Semantic concept clusters',
    note: 'Monosemantic-looking features whose top tokens form a clean conceptual neighborhood. The kind of features the SAE-interpretability community has been after.',
    items: [
      { id: 20894, caption: 'violence vocabulary', detail: '`brutal · brutality · violence · vicious · cruelty · cruel · fury · inflict`. Late-emergent, peak step 47k.' },
      { id: 4567, caption: 'inadequacy / insufficiency adjectives', detail: '`inadequate · ineffective · inadequ · unsatisfactory · inefficient · poorly · insufficient · unsatisf`. Negative-quality cluster.' },
      { id: 24191, caption: '-ive adjectives', detail: '`destructive · productive · protective · curative · informative · predictive · descriptive · explanatory`. Pure suffix-family.' },
      { id: 12617, caption: 'pluralized -tion / -sion nouns', detail: '`deliveries · insertions · conversions · explosions · inspections · victories · reductions · consultations`.' },
      { id: 3283, caption: '-ical / -istic / -atic adjective suffixes', detail: '`orical · itical · inical · ICAL · istical · matic · ogical · URAL`.' },
    ],
  },
  {
    title: 'Code & markup syntax',
    note: 'Punctuation and bracketing patterns characteristic of code, markdown, and shell scripts.',
    items: [
      { id: 23646, caption: 'bash variable interpolation', detail: '`="${ · ="$( · "$( · "${ · =\\``. Already pristine at step 512 — earliest clean crystallization. Peak step 8000.' },
      { id: 24125, caption: '`[` bracket contexts (markdown / code)', detail: 'Peak step 116000.' },
      { id: 24342, caption: '`!` exclamation combinations', detail: '`!) · !), · !). · !! · !_ · !\'`. Peak step 130000.' },
      { id: 23408, caption: 'closing-paren-with-trailing-punct (code-line endings)', detail: '` )" · ); · )) · ]; · ): · ), · ). · ], · ]"`. Peak step 143000.' },
      { id: 24104, caption: 'markdown horizontal rules / ASCII separators', detail: 'Long `--------` and `========` strings of various lengths.' },
      { id: 4556, caption: 'XML/template prelude tokens', detail: '`<? · <? · <! · <!-- · < · <% · <- · documentclass`. Persistent.' },
    ],
  },
  {
    title: 'Punctuation, quotation & dialogue',
    items: [
      { id: 15784, caption: 'quotation-mark cluster (multi-style)', detail: '`» · "" · "` · \'" · \'\' · """ · » · «`. Late-emergent peak step 116k — opening/closing quotes across styles.' },
      { id: 12138, caption: 'sentence-end-then-quote', detail: '`.\'" · !" · _." · ?" · ]." · )." · \'?" · !\'`. Persistent, peak step 143k — punctuation-then-closing-quote, dialogue-end pattern.' },
    ],
  },
  {
    title: 'Capitalisation & sentence-start',
    items: [
      { id: 17932, caption: 'capitalized name initials (St, Sh, P, R, T, S, B)', detail: 'Step-1000-emergent peak step 8000. Capitalised tokens at sentence/name beginnings.' },
      { id: 4646, caption: 'single capital letters (I, A, B, M, H, P, S, F)', detail: 'Late-emergent peak step 143k — single-letter abbreviations and sentence-initial pronouns.' },
    ],
  },
  {
    title: 'Stable from very early',
    note: 'Features whose decoder direction locks onto a coherent token cluster soon after init and barely changes through training.',
    items: [
      { id: 23451, caption: 'the "instruction" lexeme', detail: 'Persistent, peak step 32. Terminal: ` instruction · instruction · instructions · aution · Instruction · autions · instructed`.' },
    ],
  },
];

function renderExamples() {
  const card = (it) => {
    const a = STATE.arrs;
    const id = it.id;
    const tokens = a?.top5_token?.[id] ?? '';
    const peak = a?.peak_step?.[id];
    const lc = a?.lifecycle?.[id];
    const delta = a?.step1000_norm_delta?.[id];
    const meta = lc ? `<span class="ex-meta">lc=<code>${lc}</code> · peak=${peak.toLocaleString()} · Δ@1k=${delta >= 0 ? '+' : ''}${delta.toFixed(3)}</span>` : '';
    return `<a class="ex-card" href="#feat=${id}">
      <div class="ex-head">
        <span class="ex-id">#${id}</span>
        <span class="ex-cap">${escapeHtml(it.caption)}</span>
      </div>
      ${meta}
      <div class="ex-toks">${escapeHtml(tokens)}</div>
      ${it.detail ? `<div class="ex-detail">${escapeHtml(it.detail)}</div>` : ''}
    </a>`;
  };
  const groups = EXAMPLES.map(g => `
    <div class="ex-group">
      <h2>${escapeHtml(g.title)}</h2>
      ${g.note ? `<p class="ex-note">${escapeHtml(g.note)}</p>` : ''}
      <div class="ex-grid">${g.items.map(card).join('')}</div>
    </div>`).join('');
  return `<div class="examples-view">
    <div class="examples-intro">
      <h1>Curated examples</h1>
      <p>A small set of interpretable features grouped by lifecycle pattern. Click any card to open the feature page; tokens shown are the top 5 promoted at the terminal snapshot (step ${STATE.index?.meta?.terminal_step?.toLocaleString() || ''}). The atlas has 24,576 features in total — these are starting points, not a complete catalog.</p>
    </div>
    ${groups}
  </div>`;
}
function signed(v, ndig) {
  if (v == null) return '—';
  const s = v.toFixed(ndig);
  return v > 0 ? '+' + s : s;
}
function snapshotLabel(name) {
  return ({
    init: 'Init',
    warmup: 'Warmup',
    veryearly: 'Very early',
    early: 'Early',
    transition: 'Transition',
    terminal: 'Terminal',
  }[name]) || name;
}

async function load() {
  const r = await fetch('data/index.json');
  const idx = await r.json();
  STATE.index = idx;
  STATE.D = idx.meta.d_sae;
  STATE.steps = idx.steps;

  const f = idx.features;
  const step1000 = Float32Array.from(f.step1000_norm_delta);
  const step1000_abs = new Float32Array(step1000.length);
  for (let i = 0; i < step1000.length; i++) step1000_abs[i] = Math.abs(step1000[i]);
  STATE.arrs = {
    id: new Int32Array(f.id),
    lifecycle: f.lifecycle,
    peak_step: new Int32Array(f.peak_step),
    first_active_step: new Int32Array(f.first_active_step),
    lifetime_snaps: new Int32Array(f.lifetime_snaps),
    alive_at_end: f.alive_at_end,
    norm_terminal: Float32Array.from(f.norm_terminal),
    norm_peak: Float32Array.from(f.norm_peak),
    rate_terminal: Float32Array.from(f.rate_terminal),
    rate_peak: Float32Array.from(f.rate_peak),
    direction_init_to_terminal: Float32Array.from(f.direction_init_to_terminal),
    step1000_norm_delta: step1000,
    step1000_norm_delta_abs: step1000_abs,
    step1000_rate_delta: Float32Array.from(f.step1000_rate_delta),
    cusum_rates: Float32Array.from(f.cusum_rates),
    cusum_norms: Float32Array.from(f.cusum_norms),
    cusum_rotation: Float32Array.from(f.cusum_rotation),
    threshold: Float32Array.from(f.threshold),
    top1_token: f.top1_token,
    top5_token: f.top5_token,
    concept_top1: f.concept_top1,
    concept_set: f.concept_set,
  };
  STATE.conceptNames = idx.concept_names || [];

  renderHeader();
  renderFilters();
  renderTableHead();
  applyFiltersAndSort();
  renderViewport();
  setupHashRouter();
  handleHashChange();
}

function renderHeader() {
  const m = STATE.index.meta;
  document.querySelector('header.bar h1').textContent =
    `1B Crosscoder Atlas · d_sae=${m.d_sae} · seed ${m.seed}`;
  document.querySelector('header.bar .meta').textContent =
    `${m.model} · ${m.n_snapshots} snapshots · steps 0…${m.terminal_step.toLocaleString()}`;
}

function renderFilters() {
  const cats = STATE.index.lifecycle_categories;
  const sel = document.getElementById('f-lifecycle');
  sel.innerHTML = '<option value="">(all)</option>' + cats.map(c => `<option>${c}</option>`).join('');
  document.getElementById('f-lifecycle').addEventListener('change', e => { STATE.filters.lifecycle = e.target.value; refresh(); });
  document.getElementById('f-alive').addEventListener('change', e => { STATE.filters.aliveAtEnd = e.target.value; refresh(); });
  document.getElementById('f-peak-min').addEventListener('input', debounce(e => { STATE.filters.minPeakStep = parseNum(e.target.value); refresh(); }));
  document.getElementById('f-peak-max').addEventListener('input', debounce(e => { STATE.filters.maxPeakStep = parseNum(e.target.value); refresh(); }));
  document.getElementById('f-rate-min').addEventListener('input', debounce(e => { STATE.filters.minRateTerm = parseNum(e.target.value); refresh(); }));
  document.getElementById('f-token').addEventListener('input', debounce(e => { STATE.filters.tokenSubstr = e.target.value.toLowerCase(); refresh(); }));
  document.getElementById('f-jump').addEventListener('change', e => {
    const id = parseInt(e.target.value);
    if (Number.isFinite(id) && id >= 0 && id < STATE.D) location.hash = `feat=${id}`;
  });
}
function parseNum(v) { v = v.trim(); if (v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function debounce(fn, ms = 120) { let t; return e => { clearTimeout(t); t = setTimeout(() => fn(e), ms); }; }

function renderTableHead() {
  const cols = COLS.map(c => (typeof c.w === 'number' ? c.w + 'px' : c.w)).join(' ');
  document.documentElement.style.setProperty('--cols', cols);
  const head = document.querySelector('.thead');
  head.innerHTML = COLS.map(c => `<div class="th" data-key="${c.key}">${c.label}<span class="arrow"></span></div>`).join('');
  head.querySelectorAll('.th').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.key;
      if (STATE.sortKey === k) STATE.sortDir = -STATE.sortDir;
      else { STATE.sortKey = k; STATE.sortDir = COLS.find(c => c.key === k)?.num ? -1 : 1; }
      applyFiltersAndSort();
      renderViewport();
      updateSortArrows();
    });
  });
  updateSortArrows();
}
function updateSortArrows() {
  document.querySelectorAll('.thead .th').forEach(el => {
    const arr = el.querySelector('.arrow');
    if (el.dataset.key === STATE.sortKey) arr.textContent = STATE.sortDir > 0 ? '▲' : '▼';
    else arr.textContent = '';
  });
}

function applyFiltersAndSort() {
  const f = STATE.filters;
  const a = STATE.arrs;
  const D = STATE.D;
  // Concept filter uses inverted index for speed when available; otherwise falls back to membership in concept_set.
  let conceptAllowed = null;
  if (f.concept) {
    if (STATE.conceptInverted?.concepts?.[f.concept]) {
      conceptAllowed = new Uint8Array(D);
      for (const [fi, _] of STATE.conceptInverted.concepts[f.concept]) conceptAllowed[fi] = 1;
    } else {
      conceptAllowed = new Uint8Array(D);
      for (let i = 0; i < D; i++) if (a.concept_set[i].includes(f.concept)) conceptAllowed[i] = 1;
    }
  }
  const out = [];
  for (let i = 0; i < D; i++) {
    if (f.lifecycle && a.lifecycle[i] !== f.lifecycle) continue;
    if (f.aliveAtEnd === 'yes' && !a.alive_at_end[i]) continue;
    if (f.aliveAtEnd === 'no' && a.alive_at_end[i]) continue;
    if (f.minPeakStep != null && a.peak_step[i] < f.minPeakStep) continue;
    if (f.maxPeakStep != null && a.peak_step[i] > f.maxPeakStep) continue;
    if (f.minRateTerm != null && a.rate_terminal[i] < f.minRateTerm) continue;
    if (f.tokenSubstr && !a.top5_token[i].toLowerCase().includes(f.tokenSubstr)) continue;
    if (conceptAllowed && !conceptAllowed[i]) continue;
    out.push(i);
  }
  const k = STATE.sortKey, dir = STATE.sortDir;
  const col = COLS.find(c => c.key === k);
  const arr = a[k];
  if (arr instanceof Int32Array || arr instanceof Float32Array) {
    out.sort((x, y) => dir * (arr[x] - arr[y]));
  } else if (col?.num) {
    out.sort((x, y) => dir * (arr[x] - arr[y]));
  } else if (Array.isArray(arr)) {
    out.sort((x, y) => dir * (arr[x] < arr[y] ? -1 : arr[x] > arr[y] ? 1 : 0));
  }
  STATE.view = out;
  document.querySelector('.filters .stats').textContent = `${out.length.toLocaleString()} / ${D.toLocaleString()} features`;
}
function refresh() { applyFiltersAndSort(); renderViewport(); }

function renderViewport() {
  const vp = document.querySelector('.viewport');
  const spacer = vp.querySelector('.spacer');
  const rows = vp.querySelector('.rows');
  spacer.style.height = (STATE.view.length * ROW_H) + 'px';

  const draw = () => {
    const top = vp.scrollTop;
    const start = Math.max(0, Math.floor(top / ROW_H) - 5);
    const visibleN = Math.ceil(vp.clientHeight / ROW_H) + 10;
    const end = Math.min(STATE.view.length, start + visibleN);
    let html = '';
    const a = STATE.arrs;
    for (let r = start; r < end; r++) {
      const i = STATE.view[r];
      const cells = COLS.map(c => {
        const v = a[c.key][i];
        const cls = c.cls ? c.cls(v) : (c.num ? 'num' : '');
        return `<div class="cell ${cls}">${escapeHtml(c.fmt(v))}</div>`;
      }).join('');
      html += `<div class="row" style="top:${r * ROW_H}px;position:absolute;left:0;right:0" data-id="${i}">${cells}</div>`;
    }
    rows.innerHTML = html;
    rows.style.height = spacer.style.height;
  };
  draw();
  vp.onscroll = draw;
  rows.onclick = e => {
    const row = e.target.closest('.row');
    if (!row) return;
    location.hash = `feat=${row.dataset.id}`;
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- Routing -----
function setupHashRouter() {
  window.addEventListener('hashchange', handleHashChange);
}
function handleHashChange() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^feat=(\d+)$/);
  const T = document.getElementById('view-table');
  const F = document.getElementById('view-feature');
  const E = document.getElementById('view-examples');
  if (m) {
    T.classList.add('hidden'); E.classList.add('hidden');
    showFeature(parseInt(m[1]));
  } else if (h === 'examples') {
    T.classList.add('hidden'); F.classList.add('hidden');
    E.classList.remove('hidden');
    if (!E.dataset.rendered) { E.innerHTML = renderExamples(); E.dataset.rendered = '1'; }
  } else {
    F.classList.add('hidden'); E.classList.add('hidden');
    T.classList.remove('hidden');
  }
}

// ----- Feature view -----
async function loadShard(featId) {
  const sz = STATE.index.meta.shard_size;
  const lo = Math.floor(featId / sz) * sz;
  const hi = Math.min(lo + sz, STATE.D);
  const key = `${lo}_${hi}`;
  if (STATE.shardCache.has(key)) return STATE.shardCache.get(key);
  const path = `data/shards/feat_${String(lo).padStart(6, '0')}_${String(hi).padStart(6, '0')}.json`;
  const r = await fetch(path);
  const j = await r.json();
  STATE.shardCache.set(key, j);
  // Bound cache to ~6 shards.
  if (STATE.shardCache.size > 6) {
    const firstKey = STATE.shardCache.keys().next().value;
    STATE.shardCache.delete(firstKey);
  }
  return j;
}

async function showFeature(id) {
  document.getElementById('view-table').classList.add('hidden');
  const v = document.getElementById('view-feature');
  v.classList.remove('hidden');
  v.innerHTML = `<div class="loading">Loading feature ${id}…</div>`;
  const shard = await loadShard(id);
  const f = shard.features[id];
  if (!f) { v.innerHTML = `<div class="loading">Feature ${id} not found.</div>`; return; }
  v.innerHTML = renderFeature(id, f);
  v.querySelectorAll('.neighbor').forEach(el => {
    el.addEventListener('click', () => { location.hash = `feat=${el.dataset.id}`; });
  });
  // Lazy-render neighbor top1 labels (need their index entry).
  v.querySelectorAll('.neighbor').forEach(el => {
    const nid = parseInt(el.dataset.id);
    el.querySelector('.top1').textContent = STATE.arrs.top1_token[nid];
  });
  // Clicking a concept badge filters the index by that concept and returns to the table.
  v.querySelectorAll('.cbadge').forEach(el => {
    el.addEventListener('click', () => {
      const c = el.dataset.concept;
      STATE.filters.concept = c;
      const sel = document.getElementById('f-concept');
      if (sel) sel.value = c;
      location.hash = '';
      refresh();
    });
  });
}

function renderFeature(id, f) {
  const a = STATE.arrs;
  const steps = STATE.steps;
  const peakIdx = steps.indexOf(f.peak_step);
  const lifecycleClass = `lc-${f.lifecycle}`;

  const stats = [
    ['lifecycle', f.lifecycle],
    ['peak step', f.peak_step.toLocaleString()],
    ['first active', f.first_active_step < 0 ? '—' : f.first_active_step.toLocaleString()],
    ['lifetime', `${a.lifetime_snaps[id]} / ${steps.length} snaps`],
    ['Δ‖W_D‖ across step 1k', signed(a.step1000_norm_delta[id], 3)],
    ['Δ rate across step 1k', signed(a.step1000_rate_delta[id], 4)],
    ['rate(terminal)', fmtPct(a.rate_terminal[id])],
    ['rate(peak)', fmtPct(a.rate_peak[id])],
    ['‖W_D‖(terminal)', a.norm_terminal[id].toFixed(3)],
    ['‖W_D‖(peak)', a.norm_peak[id].toFixed(3)],
    ['cos(W_D₀, W_D_T)', a.direction_init_to_terminal[id].toFixed(3)],
    ['CUSUM(‖·‖)', a.cusum_norms[id].toFixed(2)],
    ['CUSUM(rot)', a.cusum_rotation[id].toFixed(2)],
    ['threshold', a.threshold[id].toFixed(3)],
  ];

  const concepts = f.concepts || [];
  const conceptBadges = concepts.length === 0 ? ''
    : concepts.map(c => `<span class="cbadge" data-concept="${c.name}">${c.name}<span class="hits">${c.hits}/${STATE.index.meta.topk_tokens}</span></span>`).join('');

  const tokenRows = (arr) => arr.map(t =>
    `<tr><td class="tok">${escapeHtml(t.tok)}</td><td class="logit">${t.logit.toFixed(2)}</td></tr>`
  ).join('');

  // Trajectory cards.
  const traj = (title, vals, opts = {}) => {
    return `<div class="traj-card">
      <div class="title"><span>${title}</span><span>${opts.last ?? vals[vals.length - 1].toFixed(3)}</span></div>
      ${sparkline(steps, vals, { peakIdx, ...opts })}
    </div>`;
  };

  const rotSteps = steps.slice(1); // rotation is step-to-step → K-1 entries

  return `
    <div class="feature-view">
      <div class="feature-header">
        <h2>Feature ${id}</h2>
        <span class="lifecycle ${lifecycleClass}">${f.lifecycle}</span>
        <span style="color:var(--muted)">peak @ step ${f.peak_step.toLocaleString()}</span>
        <span style="margin-left:auto"><a href="#">← back to table</a></span>
      </div>

      <div class="stats-grid">
        ${stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div></div>`).join('')}
      </div>

      ${concepts.length ? `<div class="section">
        <h3>Gazetteer concepts (top-30 token overlap)</h3>
        <div class="concept-badges">${conceptBadges}</div>
      </div>` : ''}

      <div class="section">
        <h3>Trajectories across snapshots <span class="legend">shaded = step 256–1k transition window</span></h3>
        <div class="trajectories">
          ${traj('decoder norm ‖W_D[s, k]‖', f.norm_traj)}
          ${traj('activation rate', f.rate_traj, { yfmt: fmtPct })}
          ${traj('cos(W_D[s, k], W_D[T, k])', f.direction_traj, { yMin: -1, yMax: 1 })}
          <div class="traj-card">
            <div class="title"><span>step-to-step rotation (radians)</span><span>${f.rotation_traj[f.rotation_traj.length - 1].toFixed(3)}</span></div>
            ${sparkline(rotSteps, f.rotation_traj, { peakIdx: -1 })}
          </div>
        </div>
      </div>

      <div class="section">
        <h3>Top promoted tokens (W_D · W_U)</h3>
        <div class="tokens-grid">
          ${(STATE.index.meta.token_snapshots || [
            {name:'init',step:0},{name:'early',step:512},
            {name:'transition',step:1000},{name:'terminal',step:STATE.index.meta.terminal_step}
          ]).map(s => `
          <div class="tokens-card">
            <div class="head">${snapshotLabel(s.name)} · step ${s.step.toLocaleString()}</div>
            <table>${tokenRows(f['top_' + s.name] || [])}</table>
          </div>`).join('')}
        </div>
      </div>

      <div class="section">
        <h3>Nearest neighbors (cosine on W_D[T])</h3>
        <div class="neighbors">
          ${f.neighbors.map(n => `<div class="neighbor" data-id="${n.id}">#${n.id}<span class="sim">cos ${n.sim.toFixed(3)}</span><span class="top1"></span></div>`).join('')}
        </div>
      </div>
    </div>
  `;
}

// Inline-SVG sparkline. xs: step values, ys: same length. peakIdx: optional marker.
function sparkline(xs, ys, opts = {}) {
  const W = 480, H = 90, pad = { l: 28, r: 6, t: 6, b: 14 };
  const xMin = Math.log(Math.max(1, xs[0]));  // log scale on training step
  const xMax = Math.log(xs[xs.length - 1]);
  const yMin = opts.yMin ?? Math.min(...ys);
  const yMax = opts.yMax ?? Math.max(...ys);
  const yLo = yMin === yMax ? yMin - 1 : yMin;
  const yHi = yMin === yMax ? yMax + 1 : yMax;
  const sx = v => pad.l + ((Math.log(Math.max(1, v)) - xMin) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
  const sy = v => pad.t + (1 - (v - yLo) / (yHi - yLo || 1)) * (H - pad.t - pad.b);
  let path = '';
  for (let i = 0; i < xs.length; i++) path += (i === 0 ? 'M' : 'L') + sx(xs[i]).toFixed(1) + ',' + sy(ys[i]).toFixed(1) + ' ';
  const yYHi = sy(yHi);
  const yYLo = sy(yLo);
  // Step-1000 transition window: shaded band [256, 1000] + dashed line at 1000.
  const meta = STATE.index?.meta || {};
  const win = meta.transition_window || [256, 1000];
  const tStep = meta.transition_step || 1000;
  let band = '';
  if (xs[xs.length - 1] >= win[0] && xs[0] <= win[1]) {
    const x1 = sx(Math.max(win[0], xs[0]));
    const x2 = sx(Math.min(win[1], xs[xs.length - 1]));
    band = `<rect class="band" x="${x1}" y="${pad.t}" width="${Math.max(1, x2 - x1)}" height="${H - pad.t - pad.b}"/>`;
  }
  let tline = '';
  if (xs[0] <= tStep && xs[xs.length - 1] >= tStep) {
    const tx = sx(tStep);
    tline = `<line class="tstep" x1="${tx}" y1="${pad.t}" x2="${tx}" y2="${H - pad.b}"/>`;
  }
  let marker = '';
  if (opts.peakIdx != null && opts.peakIdx >= 0 && opts.peakIdx < xs.length) {
    const mx = sx(xs[opts.peakIdx]);
    marker = `<line class="marker" x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${H - pad.b}"/>`;
  }
  const yfmt = opts.yfmt ?? (v => v.toFixed(2));
  const yTicks = `<text x="2" y="${yYHi + 4}">${yfmt(yHi)}</text><text x="2" y="${yYLo}">${yfmt(yLo)}</text>`;
  const xTicks = `<text x="${pad.l}" y="${H - 2}">${xs[0].toLocaleString()}</text>` +
    `<text x="${sx(tStep) - 12}" y="${H - 2}" class="tlabel">1k</text>` +
    `<text x="${W - pad.r - 30}" y="${H - 2}">${xs[xs.length - 1].toLocaleString()}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>
    <line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H - pad.b}"/>
    ${band}${tline}${marker}
    <path class="line" d="${path}"/>
    ${yTicks}${xTicks}
  </svg>`;
}

load().catch(err => {
  document.querySelector('main').innerHTML = `<div class="loading">Failed to load: ${err.message}</div>`;
  console.error(err);
});
