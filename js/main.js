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
      if (info.missing && info.missing.length) {
        msg += ' \u00b7 not found: ' + info.missing.join(', ');
      }
      focusText.textContent = msg; // textContent avoids HTML injection from table names
      focusBanner.classList.remove('hidden');
    },
    onPositionsChanged: savePositions
  });

  function savePositions() {
    if (diagram.focused) return; // don't persist temporary focus layout
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

    // table search datalist
    datalistEl.innerHTML = '';
    model.tables.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.key;
      datalistEl.appendChild(opt);
    });

    diagram.setModel(model);
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
  searchEl.addEventListener('change', runSearch);

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
