/**
 * App wiring: editor <-> parser <-> diagram, toolbar, persistence.
 */
(function () {
  'use strict';

  var SAMPLE = [
    "// Sample e-commerce schema — edit me!",
    "Table users [service_usage: 5, controller_usage: 3] {",
    "  id int [pk, increment]",
    "  username varchar(80) [not null, unique]",
    "  email varchar(255) [not null, unique]",
    "  role user_role [default: 'customer']",
    "  created_at timestamp [default: `now()`]",
    "  Note: 'Registered platform users'",
    "}",
    "",
    "Table merchants [service_usage: 2, controller_usage: 1] {",
    "  id int [pk, increment]",
    "  user_id int [not null, ref: > users.id]",
    "  store_name varchar(120) [not null]",
    "  country_code char(2)",
    "}",
    "",
    "Table products [service_usage: 4, controller_usage: 2] {",
    "  id int [pk, increment]",
    "  merchant_id int [not null]",
    "  category_id int",
    "  name varchar(255) [not null]",
    "  price decimal(10,2) [not null]",
    "  stock int [default: 0]",
    "  status product_status",
    "}",
    "",
    "Table categories {",
    "  id int [pk, increment]",
    "  parent_id int [ref: > categories.id]",
    "  name varchar(80) [not null]",
    "}",
    "",
    "Table orders [service_usage: 3, controller_usage: 2] {",
    "  id int [pk, increment]",
    "  user_id int [not null]",
    "  status order_status [not null]",
    "  total decimal(12,2)",
    "  created_at timestamp",
    "}",
    "",
    "Table order_items {",
    "  order_id int [pk]",
    "  product_id int [pk]",
    "  quantity int [not null, default: 1]",
    "  unit_price decimal(10,2) [not null]",
    "}",
    "",
    "Table payments {",
    "  id int [pk, increment]",
    "  order_id int [not null, unique]",
    "  provider varchar(40)",
    "  amount decimal(12,2) [not null]",
    "  paid_at timestamp",
    "}",
    "",
    "Table reviews {",
    "  id int [pk, increment]",
    "  user_id int [not null]",
    "  product_id int [not null]",
    "  rating int [not null, note: '1 to 5']",
    "  body text",
    "}",
    "",
    "Table addresses {",
    "  id int [pk, increment]",
    "  user_id int [not null]",
    "  line1 varchar(255)",
    "  city varchar(80)",
    "  country_code char(2)",
    "}",
    "",
    "Enum user_role { admin merchant customer }",
    "Enum order_status { pending paid shipped delivered cancelled }",
    "Enum product_status { draft active archived }",
    "",
    "Ref: products.merchant_id > merchants.id",
    "Ref: products.category_id > categories.id",
    "Ref: orders.user_id > users.id",
    "Ref: order_items.order_id > orders.id",
    "Ref: order_items.product_id > products.id",
    "Ref: payments.order_id - orders.id",
    "Ref: reviews.user_id > users.id",
    "Ref: reviews.product_id > products.id",
    "Ref: addresses.user_id > users.id",
    ""
  ].join('\n');
  var SAMPLE_SCHEMA_URL = 'schema.dbml';

  var LS_SRC = 'dbv.source';
  var LS_POS = 'dbv.positions';

  var editor = document.getElementById('editor');
  var errorsEl = document.getElementById('errors');
  var statusEl = document.getElementById('parse-status');
  var zoomEl = document.getElementById('zoom-level');
  var focusBanner = document.getElementById('focus-banner');
  var focusText = document.getElementById('focus-text');
  var searchEl = document.getElementById('search');
  var datalistEl = document.getElementById('table-list');

  var currentModel = null;
  var graph = null; // window.DBV.GraphTools instance

  // Explore panel elements
  var btnExplore    = document.getElementById('btn-explore');
  var toolsPanel    = document.getElementById('tools-panel');
  var tpClose       = document.getElementById('tp-close');
  var tpSearch      = document.getElementById('tp-search');
  var searchResults = document.getElementById('tp-search-results');
  var groupModeSel  = document.getElementById('tp-group-mode');
  var colorGroupChk = document.getElementById('tp-color-group');
  var tpGroupCount  = document.getElementById('tp-group-count');
  var groupsAllBtn  = document.getElementById('tp-groups-all');
  var groupsNoneBtn = document.getElementById('tp-groups-none');
  var groupList     = document.getElementById('tp-group-list');
  var tpSeed        = document.getElementById('tp-seed');
  var depthRange    = document.getElementById('tp-depth');
  var depthVal      = document.getElementById('tp-depth-val');
  var directionSel  = document.getElementById('tp-direction');
  var backboneChk   = document.getElementById('tp-backbone');
  var backboneRange = document.getElementById('tp-backbone-deg');
  var backboneVal   = document.getElementById('tp-backbone-val');
  var backboneRow   = document.querySelector('.tp-backbone-row');
  var analyzeBtn    = document.getElementById('tp-analyze');
  var tpPathFrom    = document.getElementById('tp-path-from');
  var tpPathTo      = document.getElementById('tp-path-to');
  var findPathBtn   = document.getElementById('tp-find-path');
  var pathMsg       = document.getElementById('tp-path-msg');

  var diagram = new window.DBV.Diagram(document.getElementById('diagram'), {
    onZoom: function (s) {
      zoomEl.textContent = Math.round(s * 100) + '%';
    },
    onFocusChanged: function (key, info) {
      if (key) {
        focusText.innerHTML =
          'Focusing on <b></b> — ' + info.total + ' related (' +
          info.incoming + ' referencing it · it references ' + info.outgoing + ')';
        focusText.querySelector('b').textContent = key;
        focusBanner.classList.remove('hidden');
      } else {
        focusBanner.classList.add('hidden');
      }
    },
    onSubsetChanged: function (keys, info) {
      var msg = 'Showing ' + info.count + ' table' + (info.count === 1 ? '' : 's') +
        ': ' + keys.join(', ') + ' \u00b7 ' + info.relations +
        ' relationship' + (info.relations === 1 ? '' : 's');
      if (info.label) {
        msg = info.label + ' \u2014 ' + info.count + ' table' + (info.count === 1 ? '' : 's') +
          ' \u00b7 ' + info.relations + ' relationship' + (info.relations === 1 ? '' : 's');
      }
      if (info.missing && info.missing.length) {
        msg += ' \u00b7 not found: ' + info.missing.join(', ');
      }
      focusText.textContent = msg; // textContent avoids HTML injection from table names
      focusBanner.classList.remove('hidden');
    },
    onPositionsChanged: savePositions
  });

  function savePositions() {
    if (diagram.focused || diagram.subset) return; // don't persist temporary focus/subset layouts
    try {
      localStorage.setItem(LS_POS, JSON.stringify(diagram.positions));
    } catch (e) { /* ignore */ }
  }

  function loadPositions() {
    try {
      var raw = localStorage.getItem(LS_POS);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  var parseTimer = null;
  function scheduleParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(parseNow, 350);
  }

  function parseNow() {
    var src = editor.value;
    try {
      localStorage.setItem(LS_SRC, src);
    } catch (e) { /* ignore */ }

    var model = window.DBV.parseDBML(src);

    errorsEl.innerHTML = '';
    if (model.errors.length) {
      statusEl.textContent = model.errors.length + ' issue' + (model.errors.length > 1 ? 's' : '');
      statusEl.className = 'status err';
      model.errors.slice(0, 30).forEach(function (e) {
        var div = document.createElement('div');
        div.textContent = (e.line ? 'L' + e.line + ': ' : '') + e.message;
        errorsEl.appendChild(div);
      });
    } else {
      statusEl.textContent = '\u2713 ' + model.tables.length + ' tables, ' + model.refs.length + ' refs';
      statusEl.className = 'status ok';
    }

    // table search datalist (suggestions for the segment after the last comma)
    updateSearchSuggestions();

    diagram.setModel(model);
    currentModel = model;
    graph = new window.DBV.GraphTools(model);
    rebuildExplore();
    return model;
  }

  function fetchShowcaseSample() {
    if (!window.fetch) return Promise.resolve(SAMPLE);
    return fetch(SAMPLE_SCHEMA_URL, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('Could not load ' + SAMPLE_SCHEMA_URL);
      return res.text();
    }).then(function (src) {
      return src && src.trim() ? src : SAMPLE;
    }, function (err) {
      console.warn('Falling back to bundled sample schema.', err);
      return SAMPLE;
    });
  }

  function loadSampleIntoEditor(src) {
    editor.value = src;
    try { localStorage.removeItem(LS_POS); } catch (e) { /* ignore */ }
    diagram.clearFocus(true);
    diagram.savedPositions = null;
    diagram.positions = {};
    diagram.selected = null;
    parseNow();
    requestAnimationFrame(function () {
      diagram.runAutoLayout();
      diagram.fit();
    });
  }

  // ---------- toolbar ----------

  document.getElementById('btn-layout').addEventListener('click', function () {
    diagram.runAutoLayout();
    diagram.fit();
  });
  document.getElementById('btn-fit').addEventListener('click', function () {
    diagram.fit();
  });
  document.getElementById('btn-zoom-in').addEventListener('click', function () {
    diagram.zoomCenter(1.2);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', function () {
    diagram.zoomCenter(1 / 1.2);
  });
  document.getElementById('btn-clear-focus').addEventListener('click', function () {
    diagram.clearFocus();
  });
  var sampleButton = document.getElementById('btn-sample');
  sampleButton.addEventListener('click', function () {
    if (editor.value.trim() && !confirm('Replace current DBML with the sample schema?')) return;
    var oldText = sampleButton.textContent;
    sampleButton.disabled = true;
    sampleButton.textContent = 'Loading…';
    fetchShowcaseSample().then(function (src) {
      loadSampleIntoEditor(src);
      sampleButton.disabled = false;
      sampleButton.textContent = oldText;
    });
  });

  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  document.getElementById('btn-export-svg').addEventListener('click', function () {
    var svg = diagram.exportSVG();
    if (!svg) return;
    download('schema.svg', new Blob([svg], { type: 'image/svg+xml' }));
  });

  document.getElementById('btn-export-png').addEventListener('click', function () {
    diagram.exportPNG(function (blob) {
      if (blob) download('schema.png', blob);
    });
  });

  // search -> focus (single table) or subset view (comma-separated tables)
  function findTableCI(name) {
    return diagram.model.tables.find(function (t) {
      return t.key.toLowerCase() === name.toLowerCase();
    });
  }

  // Rebuild the datalist so autocomplete works for each comma-separated entry:
  // suggestions carry the text before the last comma and append each table name,
  // and tables already chosen in earlier segments are omitted.
  function updateSearchSuggestions() {
    var val = searchEl.value;
    var commaIdx = val.lastIndexOf(',');
    var prefix = commaIdx >= 0 ? val.slice(0, commaIdx + 1).replace(/\s*$/, '') + ' ' : '';

    var used = {};
    if (commaIdx >= 0) {
      val.slice(0, commaIdx).split(',').forEach(function (s) {
        var name = s.trim().toLowerCase();
        if (name) used[name] = true;
      });
    }

    datalistEl.innerHTML = '';
    diagram.model.tables.forEach(function (t) {
      if (used[t.key.toLowerCase()]) return;
      var opt = document.createElement('option');
      opt.value = prefix + t.key;
      datalistEl.appendChild(opt);
    });
  }

  function runSearch() {
    var raw = searchEl.value.trim();
    if (!raw) return;

    var names = raw.split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; });

    // single table -> keep the existing focus behavior
    if (names.length <= 1) {
      var t = findTableCI(names[0] || raw);
      if (t) { diagram.focus(t.key); searchEl.blur(); }
      return;
    }

    // multiple tables -> show just those tables and the relationships between them
    var matched = [];
    var missing = [];
    names.forEach(function (n) {
      var tbl = findTableCI(n);
      if (tbl) { if (matched.indexOf(tbl.key) < 0) matched.push(tbl.key); }
      else if (missing.indexOf(n) < 0) missing.push(n);
    });
    if (matched.length) {
      diagram.showSubset(matched, missing);
      searchEl.blur();
    }
  }

  searchEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') runSearch();
  });
  searchEl.addEventListener('input', updateSearchSuggestions);
  searchEl.addEventListener('change', runSearch);

  // ================= Explore panel: search, groups, impact, path =================
  var PALETTE = [
    '#2f6feb', '#8957e5', '#1f883d', '#bf8700', '#cf222e',
    '#0598bc', '#d4641c', '#bf3989', '#57606a', '#3fb950',
    '#9e6a03', '#8250df', '#1a7f37', '#a40e26', '#0969da', '#6e7781'
  ];

  var groupState = null; // { mode, groups, keyToGroup, colorFor, hidden:{name:true} }

  function rebuildExplore() {
    if (!graph) return;
    rebuildGroups(groupModeSel.value);
    renderGroupList();
    if (tpSearch.value.trim()) renderSearchResults();
  }

  function rebuildGroups(mode) {
    var prevHidden = (groupState && groupState.hidden) || {};
    var res = graph.computeGroups(mode || 'auto');

    var colorFor = {};
    res.groups.forEach(function (g, i) { colorFor[g.name] = PALETTE[i % PALETTE.length]; });

    groupState = {
      mode: res.mode, groups: res.groups, keyToGroup: res.keyToGroup,
      colorFor: colorFor, hidden: {}
    };
    // preserve hidden groups (by name) across rebuilds where the name still exists
    Object.keys(prevHidden).forEach(function (name) {
      if (colorFor[name] != null) groupState.hidden[name] = true;
    });

    var keyColor = {};
    Object.keys(res.keyToGroup).forEach(function (k) {
      keyColor[k] = colorFor[res.keyToGroup[k]];
    });
    diagram.setGroupColors(keyColor, colorGroupChk.checked);

    var modeLabel = res.mode === 'tablegroup' ? 'by table groups'
      : res.mode === 'schema' ? 'by schema' : 'by name prefix';
    tpGroupCount.textContent = res.groups.length + ' modules · ' + modeLabel;

    applyHidden();
  }

  function applyHidden() {
    var hidden = {};
    if (groupState) {
      groupState.groups.forEach(function (g) {
        if (groupState.hidden[g.name]) g.keys.forEach(function (k) { hidden[k] = true; });
      });
    }
    diagram.setHiddenKeys(hidden);
  }

  function renderGroupList() {
    groupList.innerHTML = '';
    if (!groupState) return;
    groupState.groups.forEach(function (g) {
      var li = document.createElement('li');
      li.className = 'tp-group-item' + (groupState.hidden[g.name] ? ' hidden-group' : '');

      var left = document.createElement('div');
      left.className = 'tp-group-left';
      left.title = 'Isolate module: ' + g.name;
      var sw = document.createElement('span');
      sw.className = 'tp-group-swatch';
      sw.style.background = groupState.colorFor[g.name];
      left.appendChild(sw);
      var name = document.createElement('span');
      name.className = 'tp-group-name';
      name.textContent = g.name;
      left.appendChild(name);
      left.addEventListener('click', function () {
        diagram.showSubset(g.keys, [], { label: 'Module: ' + g.name });
        openPanel();
      });
      li.appendChild(left);

      var right = document.createElement('div');
      right.className = 'tp-group-left';
      var cnt = document.createElement('span');
      cnt.className = 'tp-group-count';
      cnt.textContent = g.keys.length;
      right.appendChild(cnt);
      var tog = document.createElement('button');
      tog.className = 'tp-group-toggle';
      tog.textContent = groupState.hidden[g.name] ? 'Show' : 'Hide';
      tog.addEventListener('click', function (e) {
        e.stopPropagation();
        groupState.hidden[g.name] = !groupState.hidden[g.name];
        renderGroupList();
        applyHidden();
      });
      right.appendChild(tog);
      li.appendChild(right);

      groupList.appendChild(li);
    });
  }

  function isolateGroupByName(nm) {
    if (!groupState) return;
    for (var i = 0; i < groupState.groups.length; i++) {
      if (groupState.groups[i].name === nm) {
        diagram.showSubset(groupState.groups[i].keys, [], { label: 'Module: ' + nm });
        return;
      }
    }
  }

  // ---- fuzzy search ----
  var searchDebounce = null;
  function renderSearchResults() {
    searchResults.innerHTML = '';
    var q = tpSearch.value.trim();
    if (!q || !graph) return;
    var results = graph.search(q, 40);
    results.forEach(function (rec) {
      var li = document.createElement('li');
      var kind = document.createElement('span');
      kind.className = 'tp-kind ' + rec.kind;
      kind.textContent = rec.kind;
      li.appendChild(kind);

      var main = document.createElement('div');
      main.className = 'tp-res-main';
      var label = document.createElement('div');
      label.className = 'tp-res-label';
      label.textContent = rec.label;
      main.appendChild(label);
      if (rec.sub) {
        var sub = document.createElement('div');
        sub.className = 'tp-res-sub';
        sub.textContent = rec.sub;
        main.appendChild(sub);
      }
      li.appendChild(main);

      li.addEventListener('click', function () {
        if (rec.kind === 'group') { isolateGroupByName(rec.label); return; }
        if (rec.tableKey) diagram.focus(rec.tableKey);
      });
      searchResults.appendChild(li);
    });
  }
  tpSearch.addEventListener('input', function () {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(renderSearchResults, 150);
  });

  // ---- impact / neighborhood ----
  function resolveSeed() {
    var typed = findTableCI(tpSeed.value.trim());
    if (typed) return typed;
    if (diagram.focused && graph.tableByKey[diagram.focused]) return graph.tableByKey[diagram.focused];
    if (diagram.selected && graph.tableByKey[diagram.selected]) return graph.tableByKey[diagram.selected];
    return null;
  }

  function runAnalyze() {
    if (!graph) return;
    var seed = resolveSeed();
    if (!seed) {
      setPathMsg('Type a focus table name for the neighborhood.', 'err');
      tpSeed.focus();
      return;
    }
    var depth = parseInt(depthRange.value, 10) || 1;
    var dir = directionSel.value;
    var keys = graph.neighborhood(seed.key, { depth: depth, direction: dir });

    if (backboneChk.checked) {
      var minDeg = parseInt(backboneRange.value, 10) || 1;
      keys = graph.backbone(keys, minDeg);
      if (keys.indexOf(seed.key) < 0) keys.unshift(seed.key); // always keep the seed
    }

    var dirLabel = dir === 'in' ? 'dependents' : dir === 'out' ? 'dependencies' : 'neighbors';
    diagram.showSubset(keys, [], {
      label: seed.name + ' · ' + depth + '-hop ' + dirLabel +
        (backboneChk.checked ? ' · backbone' : '')
    });
    setPathMsg('', '');
  }

  depthRange.addEventListener('input', function () { depthVal.textContent = depthRange.value; });
  backboneRange.addEventListener('input', function () { backboneVal.textContent = backboneRange.value; });
  backboneChk.addEventListener('change', function () {
    backboneRow.classList.toggle('active', backboneChk.checked);
  });
  analyzeBtn.addEventListener('click', runAnalyze);

  // ---- path finder ----
  function setPathMsg(text, cls) {
    pathMsg.textContent = text || '';
    pathMsg.className = 'tp-msg' + (cls ? ' ' + cls : '');
  }
  function runPathFind() {
    if (!graph) return;
    var a = findTableCI(tpPathFrom.value.trim());
    var b = findTableCI(tpPathTo.value.trim());
    if (!a || !b) { setPathMsg('Enter two existing table names.', 'err'); return; }
    if (a.key === b.key) { setPathMsg('Pick two different tables.', 'err'); return; }
    var path = graph.shortestPath(a.key, b.key);
    if (!path) { setPathMsg('No relationship path connects these tables.', 'err'); return; }
    var hops = path.length - 1;
    setPathMsg(path.join(' → ') + '  (' + hops + ' hop' + (hops === 1 ? '' : 's') + ')', 'ok');
    diagram.showSubset(path, [], { pathHighlight: true, label: 'Path: ' + a.name + ' → ' + b.name });
  }
  findPathBtn.addEventListener('click', runPathFind);
  [tpPathFrom, tpPathTo].forEach(function (inp) {
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runPathFind(); });
  });

  // ---- groups controls ----
  groupModeSel.addEventListener('change', function () {
    rebuildGroups(groupModeSel.value);
    renderGroupList();
  });
  colorGroupChk.addEventListener('change', function () {
    diagram.setColorByGroup(colorGroupChk.checked);
  });
  groupsAllBtn.addEventListener('click', function () {
    if (!groupState) return;
    groupState.hidden = {};
    renderGroupList();
    applyHidden();
  });
  groupsNoneBtn.addEventListener('click', function () {
    if (!groupState) return;
    groupState.groups.forEach(function (g) { groupState.hidden[g.name] = true; });
    renderGroupList();
    applyHidden();
  });

  // ---- panel open/close ----
  function openPanel() { toolsPanel.classList.remove('collapsed'); }
  function togglePanel() { toolsPanel.classList.toggle('collapsed'); }
  btnExplore.addEventListener('click', togglePanel);
  tpClose.addEventListener('click', function () { toolsPanel.classList.add('collapsed'); });

  // ESC clears focus
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') diagram.clearFocus();
  });

  // editor
  editor.addEventListener('input', scheduleParse);
  editor.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      var s = editor.selectionStart, e = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(e);
      editor.selectionStart = editor.selectionEnd = s + 2;
      scheduleParse();
    }
  });

  // ---------- splitter ----------
  var splitter = document.getElementById('splitter');
  var editorPane = document.getElementById('editor-pane');
  splitter.addEventListener('pointerdown', function (ev) {
    splitter.setPointerCapture(ev.pointerId);
    var startX = ev.clientX;
    var startW = editorPane.offsetWidth;
    function move(e2) {
      editorPane.style.width = Math.max(160, startW + (e2.clientX - startX)) + 'px';
    }
    function up(e2) {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    }
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // resize -> nothing destructive; user can hit Fit

  // ---------- boot ----------
  var saved = null;
  try { saved = localStorage.getItem(LS_SRC); } catch (e) { /* ignore */ }
  editor.value = saved != null && saved.trim() !== '' ? saved : SAMPLE;

  var savedPos = loadPositions();
  if (savedPos) diagram.positions = savedPos;

  parseNow();
  // fit after first paint
  requestAnimationFrame(function () { diagram.fit(); });
})();
