/**
 * JSON Viewer — parses JSON and renders a collapsible, searchable tree.
 * Format / minify / copy / import, expand-collapse, and localStorage persistence.
 * All text is inserted via textContent so hostile JSON strings can't inject markup.
 */
(function () {
  'use strict';

  var editor      = document.getElementById('editor');
  var errorsEl    = document.getElementById('errors');
  var statusEl    = document.getElementById('parse-status');
  var treeEl      = document.getElementById('tree');
  var treeEmpty   = document.getElementById('tree-empty');
  var statsEl     = document.getElementById('stats');
  var searchEl    = document.getElementById('search');
  var fileInput   = document.getElementById('file-input');

  var btnFormat   = document.getElementById('btn-format');
  var btnMinify   = document.getElementById('btn-minify');
  var btnCopy     = document.getElementById('btn-copy');
  var btnClear    = document.getElementById('btn-clear');
  var btnSample   = document.getElementById('btn-sample');
  var btnExpand   = document.getElementById('btn-expand');
  var btnCollapse = document.getElementById('btn-collapse');

  var LS_SRC = 'dbv.json.src';

  var SAMPLE = JSON.stringify({
    id: 42,
    name: "Ada Lovelace",
    active: true,
    roles: ["admin", "engineer"],
    profile: {
      email: "ada@example.com",
      age: 36,
      address: { city: "London", country: "UK", postcode: null },
      social: { github: "ada", twitter: null }
    },
    projects: [
      { id: 1, title: "Analytical Engine", stars: 1815, tags: ["math", "computing"] },
      { id: 2, title: "Notes", stars: 187, tags: [] }
    ],
    balance: 1024.75,
    lastLogin: "2026-07-23T10:15:00Z"
  }, null, 2);

  var parsedData = null; // last successfully parsed value

  // ---------- DOM helpers ----------
  function div(cls) { var e = document.createElement('div'); if (cls) e.className = cls; return e; }
  function span(cls) { var e = document.createElement('span'); if (cls) e.className = cls; return e; }

  function typeName(v) {
    if (v === null) return 'null';
    var t = typeof v;
    return t === 'object' ? 'object' : t;
  }

  function formatPrimitive(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v); // keeps quotes + escapes
    return String(v);
  }

  // Append `text` to `parent`, wrapping every case-insensitive `query` match in a
  // highlight span. Returns true if at least one match was found.
  function appendHighlighted(parent, text, query) {
    if (!query) { parent.appendChild(document.createTextNode(text)); return false; }
    var lower = text.toLowerCase();
    var q = query.toLowerCase();
    var idx = lower.indexOf(q);
    if (idx < 0) { parent.appendChild(document.createTextNode(text)); return false; }
    var pos = 0;
    while (idx >= 0) {
      if (idx > pos) parent.appendChild(document.createTextNode(text.slice(pos, idx)));
      var hit = span('json-hit');
      hit.textContent = text.slice(idx, idx + q.length);
      parent.appendChild(hit);
      pos = idx + q.length;
      idx = lower.indexOf(q, pos);
    }
    if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
    return true;
  }

  // ---------- tree rendering ----------
  // Returns a DOM node, or null when filtering and nothing in this subtree matches.
  function createNode(keyText, value, query, keyIsIndex, forceInclude) {
    var node = div('json-node');
    var row = div('json-row');
    node.appendChild(row);

    var toggle = span('toggle');
    toggle.textContent = '\u25be'; // ▾
    row.appendChild(toggle);

    var selfMatch = false;

    if (keyText !== null) {
      var keyEl = span('json-key');
      var label = keyIsIndex ? keyText : '"' + keyText + '"';
      if (appendHighlighted(keyEl, label, query)) selfMatch = true;
      row.appendChild(keyEl);
      var colon = span('json-colon');
      colon.textContent = ': ';
      row.appendChild(colon);
    }

    var isContainer = value !== null && typeof value === 'object';

    if (!isContainer) {
      toggle.classList.add('leaf');
      var valEl = span('json-value ' + typeName(value));
      if (appendHighlighted(valEl, formatPrimitive(value), query)) selfMatch = true;
      row.appendChild(valEl);
      if (query && !forceInclude && !selfMatch) return null;
      return node;
    }

    var isArr = Array.isArray(value);
    var entries = isArr
      ? value.map(function (v, i) { return [String(i), v, true]; })
      : Object.keys(value).map(function (k) { return [k, value[k], false]; });

    row.classList.add('expandable');
    var bracket = span('json-punct');
    bracket.textContent = isArr ? '[ ]' : '{ }';
    row.appendChild(bracket);
    var count = span('json-count');
    count.textContent = entries.length + (entries.length === 1 ? ' item' : ' items');
    row.appendChild(count);

    var children = div('json-children');
    node.appendChild(children);

    var childForce = forceInclude || selfMatch; // key matched -> keep all descendants
    var anyChildMatch = false;
    entries.forEach(function (e) {
      var child = createNode(e[0], e[1], query, e[2], childForce);
      if (child) { children.appendChild(child); anyChildMatch = true; }
    });

    var matched = selfMatch || anyChildMatch;
    if (query && !forceInclude && !matched) return null;

    if (query) node.classList.remove('collapsed'); // auto-expand matches

    row.addEventListener('click', function () {
      node.classList.toggle('collapsed');
    });

    return node;
  }

  function renderTree(data, query) {
    treeEl.innerHTML = '';
    var rootKey = null;
    var node = createNode(rootKey, data, query || '', false, false);
    if (node) {
      treeEl.appendChild(node);
      treeEmpty.classList.add('hidden');
    } else {
      // filtering hid everything
      treeEmpty.textContent = 'No keys or values match "' + query + '".';
      treeEmpty.classList.remove('hidden');
    }
  }

  function showEmptyTree(message) {
    treeEl.innerHTML = '';
    treeEmpty.textContent = message;
    treeEmpty.classList.remove('hidden');
  }

  // ---------- stats ----------
  function computeStats(data) {
    var nodes = 0;
    (function walk(v) {
      nodes++;
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach(walk);
        else Object.keys(v).forEach(function (k) { walk(v[k]); });
      }
    })(data);

    var topType = Array.isArray(data) ? 'Array'
      : (data !== null && typeof data === 'object') ? 'Object'
      : typeName(data);
    var topSize = Array.isArray(data) ? data.length
      : (data !== null && typeof data === 'object') ? Object.keys(data).length : 0;

    var parts = [topType];
    if (topType === 'Object') parts.push(topSize + (topSize === 1 ? ' key' : ' keys'));
    if (topType === 'Array') parts.push(topSize + (topSize === 1 ? ' item' : ' items'));
    parts.push(nodes + (nodes === 1 ? ' node' : ' nodes'));
    return parts.join(' \u00b7 ');
  }

  // ---------- error position ----------
  function describeError(err, src) {
    var msg = err && err.message ? err.message : String(err);
    var m = msg.match(/position\s+(\d+)/i);
    if (m) {
      var pos = parseInt(m[1], 10);
      var line = 1, col = 1;
      for (var i = 0; i < pos && i < src.length; i++) {
        if (src[i] === '\n') { line++; col = 1; } else { col++; }
      }
      return 'Line ' + line + ', column ' + col + ': ' + msg;
    }
    return msg;
  }

  // ---------- parse pipeline ----------
  function parseAndRender() {
    var src = editor.value;
    try { localStorage.setItem(LS_SRC, src); } catch (e) { /* ignore */ }

    errorsEl.innerHTML = '';

    if (!src.trim()) {
      parsedData = null;
      statusEl.textContent = '\u2013';
      statusEl.className = 'status ok';
      statsEl.textContent = '';
      showEmptyTree('Enter valid JSON to see the tree view.');
      return;
    }

    try {
      parsedData = JSON.parse(src);
    } catch (err) {
      parsedData = null;
      statusEl.textContent = 'invalid';
      statusEl.className = 'status err';
      statsEl.textContent = '';
      var d = div();
      d.textContent = describeError(err, src);
      errorsEl.appendChild(d);
      showEmptyTree('Fix the JSON error to see the tree view.');
      return;
    }

    statusEl.textContent = '\u2713 valid';
    statusEl.className = 'status ok';
    statsEl.textContent = computeStats(parsedData);
    renderTree(parsedData, searchEl.value.trim());
  }

  var parseTimer = null;
  function scheduleParse() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(parseAndRender, 250);
  }

  // ---------- search ----------
  var searchTimer = null;
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (parsedData !== null) renderTree(parsedData, searchEl.value.trim());
    }, 200);
  });

  // ---------- toolbar ----------
  btnFormat.addEventListener('click', function () {
    try {
      var data = JSON.parse(editor.value);
      editor.value = JSON.stringify(data, null, 2);
      parseAndRender();
    } catch (e) { parseAndRender(); }
  });

  btnMinify.addEventListener('click', function () {
    try {
      var data = JSON.parse(editor.value);
      editor.value = JSON.stringify(data);
      parseAndRender();
    } catch (e) { parseAndRender(); }
  });

  btnCopy.addEventListener('click', function () {
    if (parsedData === null) return;
    var text = JSON.stringify(parsedData, null, 2);
    var done = function () {
      var old = btnCopy.textContent;
      btnCopy.textContent = 'Copied';
      setTimeout(function () { btnCopy.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  btnClear.addEventListener('click', function () {
    editor.value = '';
    searchEl.value = '';
    parseAndRender();
    editor.focus();
  });

  btnSample.addEventListener('click', function () {
    editor.value = SAMPLE;
    searchEl.value = '';
    parseAndRender();
  });

  function setAllCollapsed(collapsed) {
    var nodes = treeEl.querySelectorAll('.json-node');
    for (var i = 0; i < nodes.length; i++) {
      // only container nodes have children
      if (nodes[i].querySelector(':scope > .json-children')) {
        nodes[i].classList.toggle('collapsed', collapsed);
      }
    }
  }
  btnExpand.addEventListener('click', function () { setAllCollapsed(false); });
  btnCollapse.addEventListener('click', function () { setAllCollapsed(true); });

  // ---------- file import ----------
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      editor.value = e.target.result;
      searchEl.value = '';
      parseAndRender();
    };
    reader.onerror = function () { alert('Could not read the file.'); };
    reader.readAsText(file);
    fileInput.value = '';
  });

  // ---------- editor ----------
  editor.addEventListener('input', scheduleParse);
  editor.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      var s = editor.selectionStart, en = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
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
      editorPane.style.width = Math.max(200, startW + (e2.clientX - startX)) + 'px';
    }
    function up() {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    }
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  // ---------- boot ----------
  var saved = null;
  try { saved = localStorage.getItem(LS_SRC); } catch (e) { /* ignore */ }
  editor.value = saved != null ? saved : SAMPLE;
  parseAndRender();
})();
