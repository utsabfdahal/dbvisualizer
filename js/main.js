/**
 * App wiring: editor <-> parser <-> diagram, toolbar, persistence.
 */
(function () {
  'use strict';

  var SAMPLE = [
    "// Sample e-commerce schema — edit me!",
    "Table users {",
    "  id int [pk, increment]",
    "  username varchar(80) [not null, unique]",
    "  email varchar(255) [not null, unique]",
    "  role user_role [default: 'customer']",
    "  created_at timestamp [default: `now()`]",
    "  Note: 'Registered platform users'",
    "}",
    "",
    "Table merchants {",
    "  id int [pk, increment]",
    "  user_id int [not null, ref: > users.id]",
    "  store_name varchar(120) [not null]",
    "  country_code char(2)",
    "}",
    "",
    "Table products {",
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
    "Table orders {",
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
  document.getElementById('btn-sample').addEventListener('click', function () {
    if (editor.value.trim() && !confirm('Replace current DBML with the sample schema?')) return;
    editor.value = SAMPLE;
    localStorage.removeItem(LS_POS);
    diagram.positions = {};
    diagram.clearFocus(true);
    parseNow();
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

  // search -> focus
  searchEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var v = searchEl.value.trim();
      if (!v) return;
      var t = diagram.model.tables.find(function (t) {
        return t.key.toLowerCase() === v.toLowerCase();
      });
      if (t) {
        diagram.focus(t.key);
        searchEl.blur();
      }
    }
  });
  searchEl.addEventListener('change', function () {
    var v = searchEl.value.trim();
    var t = diagram.model.tables.find(function (t) {
      return t.key.toLowerCase() === v.toLowerCase();
    });
    if (t) diagram.focus(t.key);
  });

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
