/**
 * SVG diagram renderer with pan/zoom, draggable tables, relation edges,
 * hover highlighting and focus mode (table + its incoming/outgoing relations).
 *
 * window.DBV.Diagram
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  var HEADER_H = 34;
  var ROW_H = 27;
  var PAD_X = 14;
  var MIN_W = 180;

  var PALETTE = [
    '#2f6feb', '#8957e5', '#1f883d', '#bf8700', '#cf222e',
    '#0598bc', '#d4641c', '#bf3989', '#57606a', '#3fb950'
  ];

  var SVG_STYLE = [
    'text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.tbl-box { fill: #232730; stroke: #3a4150; stroke-width: 1; rx: 8; }',
    '.tbl-header-text { fill: #ffffff; font-size: 13.5px; font-weight: 600; }',
    '.tbl-schema-text { fill: rgba(255,255,255,0.75); font-size: 10px; }',
    '.col-name { fill: #d7dae0; font-size: 12.5px; }',
    '.col-name.pk { font-weight: 700; }',
    '.col-type { fill: #7c8493; font-size: 11.5px; }',
    '.col-pk-icon { fill: #e3b341; font-size: 10px; }',
    '.row-line { stroke: #2c313c; stroke-width: 1; }',
    '.edge { fill: none; stroke: #5b6372; stroke-width: 1.6; }',
    '.edge-hit { fill: none; stroke: transparent; stroke-width: 12; cursor: pointer; }',
    '.edge-label { fill: #9aa3b2; font-size: 11px; font-weight: 600; }',
    '.edge-dot { fill: #5b6372; }',
    'g.edge-g.hl .edge { stroke: #4f8ef7; stroke-width: 2.2; }',
    'g.edge-g.hl .edge-label { fill: #7eb1ff; }',
    'g.edge-g.hl .edge-dot { fill: #4f8ef7; }',
    'g.dim { opacity: 0.18; }',
    '.side-label { fill: #8b94a7; font-size: 26px; font-weight: 700; letter-spacing: 0.5px; }',
    'g.tbl-g { cursor: grab; }',
    'g.tbl-g.dragging { cursor: grabbing; }',
    'g.tbl-g.selected .tbl-box { stroke: #4f8ef7; stroke-width: 2; }',
    '.badge { fill: #313845; }',
    '.badge-text { fill: #9aa3b2; font-size: 9px; font-weight: 600; }'
  ].join('\n');

  // text measurement
  var _ctx = document.createElement('canvas').getContext('2d');
  function measure(text, font) {
    _ctx.font = font;
    return _ctx.measureText(text).width;
  }

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  function Diagram(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks || {};
    this.model = { tables: [], refs: [], enums: [] };
    this.positions = {};       // key -> {x, y}
    this.savedPositions = null; // backup while focused
    this.geom = {};            // key -> {x,y,w,h,rowY:{col:y}}
    this.focused = null;
    this.selected = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._edgeEls = [];
    this._tableEls = {};
    this._enumMap = {};

    this.svg = el('svg', { xmlns: NS }, container);
    var style = el('style', null, this.svg);
    style.textContent = SVG_STYLE;
    this.viewport = el('g', { class: 'viewport' }, this.svg);
    this.edgeLayer = el('g', { class: 'edges' }, this.viewport);
    this.tableLayer = el('g', { class: 'tables' }, this.viewport);
    this.labelLayer = el('g', { class: 'labels' }, this.viewport);

    this._bindPanZoom();
  }

  // ---------------- data ----------------

  Diagram.prototype.setModel = function (model) {
    var self = this;
    this.model = model;
    this._enumMap = {};
    (model.enums || []).forEach(function (en) {
      self._enumMap[en.name.toLowerCase()] = en;
    });

    // adjacency cache: table key -> { relatedKey: true }
    this._adj = {};
    model.refs.forEach(function (r) {
      var a = r.from.table, b = r.to.table;
      (self._adj[a] = self._adj[a] || {})[b] = true;
      (self._adj[b] = self._adj[b] || {})[a] = true;
    });
    model.tables.forEach(function (t) {
      if (self._adj[t.key]) delete self._adj[t.key][t.key];
    });

    // drop positions of removed tables; keep existing ones
    var valid = {};
    model.tables.forEach(function (t) { valid[t.key] = true; });
    Object.keys(this.positions).forEach(function (k) {
      if (!valid[k]) delete self.positions[k];
    });
    // keep the saved overview layout (focus-mode backup) in sync too
    if (this.savedPositions) {
      Object.keys(this.savedPositions).forEach(function (k) {
        if (!valid[k]) delete self.savedPositions[k];
      });
    }
    if (this.focused && !valid[this.focused]) this.clearFocus(true);
    if (this.selected && !valid[this.selected]) this.selected = null;

    // give new tables a position
    var newOnes = model.tables.filter(function (t) { return !self.positions[t.key]; });
    if (newOnes.length === model.tables.length && model.tables.length > 0) {
      this.runAutoLayout();
      this.fit();
      return;
    }
    var off = 0;
    newOnes.forEach(function (t) {
      self.positions[t.key] = { x: 40 + off, y: 40 + off };
      if (self.savedPositions && !self.savedPositions[t.key]) {
        self.savedPositions[t.key] = { x: 40 + off, y: 40 + off };
      }
      off += 36;
    });
    // tables that exist only in savedPositions (added while focused) need entries there too
    if (this.savedPositions) {
      model.tables.forEach(function (t) {
        if (!self.savedPositions[t.key]) {
          self.savedPositions[t.key] = { x: 40 + off, y: 40 + off };
          off += 36;
        }
      });
    }
    this.render();
  };

  Diagram.prototype._sizeOf = function (t) {
    var headerFont = '600 13.5px -apple-system, "Segoe UI", Roboto, sans-serif';
    var rowFont = '12.5px -apple-system, "Segoe UI", Roboto, sans-serif';
    var typeFont = '11.5px -apple-system, "Segoe UI", Roboto, sans-serif';
    var w = Math.max(MIN_W, measure(t.name, headerFont) + PAD_X * 2 + 20);
    t.columns.forEach(function (c) {
      var cw = PAD_X + (c.pk ? 16 : 0) + measure(c.name, rowFont) + 24 + measure(c.type, typeFont) + PAD_X;
      if (cw > w) w = cw;
    });
    w = Math.min(Math.ceil(w), 420);
    var h = HEADER_H + Math.max(1, t.columns.length) * ROW_H;
    return { w: w, h: h };
  };

  Diagram.prototype._headerColor = function (t, idx) {
    var s = t.settings || {};
    var c = s.headercolor || s.color;
    if (c) return c;
    return PALETTE[idx % PALETTE.length];
  };

  // table keys visible under current focus
  Diagram.prototype.visibleKeys = function () {
    var self = this;
    if (!this.focused) {
      return this.model.tables.map(function (t) { return t.key; });
    }
    var set = {};
    set[this.focused] = true;
    this.model.refs.forEach(function (r) {
      if (r.from.table === self.focused) set[r.to.table] = true;
      if (r.to.table === self.focused) set[r.from.table] = true;
    });
    return Object.keys(set);
  };

  Diagram.prototype.relatedTables = function (key) {
    return Object.keys((this._adj && this._adj[key]) || {});
  };

  // ---------------- rendering ----------------

  Diagram.prototype.render = function () {
    var self = this;
    this.tableLayer.innerHTML = '';
    this.edgeLayer.innerHTML = '';
    this.labelLayer.innerHTML = '';
    this._tableEls = {};
    this._edgeEls = [];
    this.geom = {};

    var visible = {};
    this.visibleKeys().forEach(function (k) { visible[k] = true; });

    // geometry first
    this.model.tables.forEach(function (t) {
      if (!visible[t.key]) return;
      var size = self._sizeOf(t);
      var pos = self.positions[t.key] || { x: 0, y: 0 };
      var rowY = {};
      t.columns.forEach(function (c, ri) {
        rowY[c.name] = pos.y + HEADER_H + ri * ROW_H + ROW_H / 2;
      });
      self.geom[t.key] = { x: pos.x, y: pos.y, w: size.w, h: size.h, rowY: rowY };
    });

    // edges (under tables)
    this.model.refs.forEach(function (r, i) {
      if (!visible[r.from.table] || !visible[r.to.table]) return;
      if (self.focused && r.from.table !== self.focused && r.to.table !== self.focused) return;
      self._renderEdge(r, i);
    });

    // tables
    this.model.tables.forEach(function (t, idx) {
      if (!visible[t.key]) return;
      self._renderTable(t, idx);
    });

    this._renderFocusLabels();
    this._applyViewTransform();
  };

  Diagram.prototype._renderTable = function (t, idx) {
    var self = this;
    var g = this.geom[t.key];
    var grp = el('g', {
      class: 'tbl-g' + (this.selected === t.key ? ' selected' : ''),
      transform: 'translate(' + g.x + ',' + g.y + ')',
      'data-key': t.key
    }, this.tableLayer);

    // shadow + body
    el('rect', { class: 'tbl-box', width: g.w, height: g.h, rx: 8 }, grp);

    // header
    var hdrColor = this._headerColor(t, idx);
    var hdr = el('path', {
      d: 'M0 8 a8 8 0 0 1 8 -8 h' + (g.w - 16) + ' a8 8 0 0 1 8 8 v' + (HEADER_H - 8) + ' h-' + g.w + ' z',
      fill: hdrColor
    }, grp);
    hdr.style.cursor = 'grab';

    var title = el('text', {
      class: 'tbl-header-text',
      x: PAD_X,
      y: HEADER_H / 2 + (t.schema ? 7 : 4.5)
    }, grp);
    title.textContent = t.name;
    if (t.schema) {
      var st = el('text', { class: 'tbl-schema-text', x: PAD_X, y: 11 }, grp);
      st.textContent = t.schema;
    }
    if (t.note) {
      var tt = el('title', null, grp);
      tt.textContent = t.name + ' — ' + t.note;
    }

    // relation count badge
    var relCount = this.relatedTables(t.key).length;
    if (relCount > 0) {
      var bw = 22;
      el('rect', { class: 'badge', x: g.w - bw - 8, y: 9, width: bw, height: 16, rx: 8, fill: 'rgba(0,0,0,0.28)' }, grp);
      var bt = el('text', { class: 'badge-text', x: g.w - bw / 2 - 8, y: 20.5, 'text-anchor': 'middle', fill: 'rgba(255,255,255,0.85)' }, grp);
      bt.textContent = String(relCount);
    }

    // rows
    t.columns.forEach(function (c, ri) {
      var y = HEADER_H + ri * ROW_H;
      if (ri > 0) {
        el('line', { class: 'row-line', x1: 1, y1: y, x2: g.w - 1, y2: y }, grp);
      }
      var rowG = el('g', null, grp);
      var x = PAD_X;
      if (c.pk) {
        var key = el('text', { class: 'col-pk-icon', x: x - 2, y: y + ROW_H / 2 + 3.5 }, rowG);
        key.textContent = '\uD83D\uDD11'; // key emoji
        x += 16;
      }
      var nameEl = el('text', {
        class: 'col-name' + (c.pk ? ' pk' : ''),
        x: x,
        y: y + ROW_H / 2 + 4
      }, rowG);
      nameEl.textContent = c.name + (c.notNull && !c.pk ? ' *' : '');

      var typeEl = el('text', {
        class: 'col-type',
        x: g.w - PAD_X,
        y: y + ROW_H / 2 + 4,
        'text-anchor': 'end'
      }, rowG);
      var isEnum = self._enumMap[(c.type || '').toLowerCase()];
      typeEl.textContent = c.type;
      if (isEnum) typeEl.setAttribute('fill', '#b58ee8');

      var tipBits = [];
      if (c.pk) tipBits.push('PRIMARY KEY');
      if (c.unique) tipBits.push('UNIQUE');
      if (c.notNull) tipBits.push('NOT NULL');
      if (c.increment) tipBits.push('AUTO INCREMENT');
      if (c.default != null) tipBits.push('default: ' + c.default);
      if (c.note) tipBits.push(c.note);
      if (isEnum) tipBits.push('enum: ' + isEnum.values.join(', '));
      if (tipBits.length) {
        var ct = el('title', null, rowG);
        ct.textContent = c.name + ' ' + c.type + '\n' + tipBits.join(' · ');
      }
    });

    this._tableEls[t.key] = grp;
    this._bindTableEvents(grp, t.key);
  };

  Diagram.prototype._edgeAnchors = function (r) {
    var a = this.geom[r.from.table];
    var b = this.geom[r.to.table];
    if (!a || !b) return null;

    var ay = (a.rowY && a.rowY[r.from.column] != null) ? a.rowY[r.from.column] : a.y + HEADER_H / 2;
    var by = (b.rowY && b.rowY[r.to.column] != null) ? b.rowY[r.to.column] : b.y + HEADER_H / 2;

    var sideA, sideB;
    if (r.from.table === r.to.table) {
      sideA = 1; sideB = 1; // self loop on right
    } else if (b.x >= a.x + a.w + 20) {
      sideA = 1; sideB = -1;
    } else if (b.x + b.w <= a.x - 20) {
      sideA = -1; sideB = 1;
    } else {
      // horizontally overlapping: route both on the same side with more space
      var rightRoom = Math.max(a.x + a.w, b.x + b.w);
      var leftRoom = Math.min(a.x, b.x);
      if (Math.abs(rightRoom) <= Math.abs(leftRoom)) { sideA = 1; sideB = 1; }
      else { sideA = -1; sideB = -1; }
    }
    return {
      a: { x: sideA > 0 ? a.x + a.w : a.x, y: ay, side: sideA },
      b: { x: sideB > 0 ? b.x + b.w : b.x, y: by, side: sideB }
    };
  };

  function cardinality(op) {
    switch (op) {
      case '>': return { from: '*', to: '1' };
      case '<': return { from: '1', to: '*' };
      case '-': return { from: '1', to: '1' };
      case '<>': return { from: '*', to: '*' };
      default: return { from: '', to: '' };
    }
  }

  Diagram.prototype._renderEdge = function (r, idx) {
    var pts = this._edgeAnchors(r);
    if (!pts) return;
    var a = pts.a, b = pts.b;

    var grp = el('g', { class: 'edge-g', 'data-idx': idx }, this.edgeLayer);

    var d;
    if (r.from.table === r.to.table) {
      var loop = 70;
      d = 'M ' + a.x + ' ' + a.y +
        ' C ' + (a.x + loop) + ' ' + a.y + ', ' + (b.x + loop) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
    } else {
      var dx = Math.max(46, Math.abs(b.x - a.x) / 2);
      d = 'M ' + a.x + ' ' + a.y +
        ' C ' + (a.x + a.side * dx) + ' ' + a.y + ', ' + (b.x + b.side * dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
    }

    el('path', { class: 'edge', d: d }, grp);
    var hit = el('path', { class: 'edge-hit', d: d }, grp);

    el('circle', { class: 'edge-dot', cx: a.x, cy: a.y, r: 3.2 }, grp);
    el('circle', { class: 'edge-dot', cx: b.x, cy: b.y, r: 3.2 }, grp);

    var card = cardinality(r.op);
    var la = el('text', { class: 'edge-label', x: a.x + a.side * 10, y: a.y - 7, 'text-anchor': a.side > 0 ? 'start' : 'end' }, grp);
    la.textContent = card.from;
    var lb = el('text', { class: 'edge-label', x: b.x + b.side * 10, y: b.y - 7, 'text-anchor': b.side > 0 ? 'start' : 'end' }, grp);
    lb.textContent = card.to;

    var tip = el('title', null, grp);
    tip.textContent =
      r.from.table + '.' + (r.from.columns || [r.from.column]).join(',') +
      '  ' + r.op + '  ' +
      r.to.table + '.' + (r.to.columns || [r.to.column]).join(',');

    var self = this;
    hit.addEventListener('mouseenter', function () { grp.classList.add('hl'); });
    hit.addEventListener('mouseleave', function () { if (self._hoverKey == null) grp.classList.remove('hl'); });

    this._edgeEls.push({ grp: grp, ref: r });
  };

  // ---------------- interaction: tables ----------------

  Diagram.prototype._bindTableEvents = function (grp, key) {
    var self = this;
    var drag = null;

    grp.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation();
      grp.setPointerCapture(ev.pointerId);
      var pos = self.positions[key] || (self.positions[key] = { x: 0, y: 0 });
      drag = { sx: ev.clientX, sy: ev.clientY, ox: pos.x, oy: pos.y, moved: false };
      grp.classList.add('dragging');
    });

    grp.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = (ev.clientX - drag.sx) / self.scale;
      var dy = (ev.clientY - drag.sy) / self.scale;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      self.positions[key] = { x: drag.ox + dx, y: drag.oy + dy };
      self._moveTable(key);
    });

    grp.addEventListener('pointerup', function (ev) {
      grp.classList.remove('dragging');
      var wasDrag = drag && drag.moved;
      drag = null;
      if (!wasDrag) {
        // single click focuses the table and lays out its relations around it
        self.focus(key);
        return;
      }
      if (self.callbacks.onPositionsChanged) self.callbacks.onPositionsChanged();
    });

    grp.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      self.focus(key);
    });

    grp.addEventListener('mouseenter', function () { self._hover(key); });
    grp.addEventListener('mouseleave', function () { self._hover(null); });
  };

  Diagram.prototype._moveTable = function (key) {
    var pos = this.positions[key];
    var g = this.geom[key];
    if (g) {
      var dy = pos.y - g.y;
      g.x = pos.x;
      g.y = pos.y;
      for (var c in g.rowY) g.rowY[c] += dy;
      // recompute rowY fully (x change doesn't affect it, but keep consistent)
      var t = this._findTable(key);
      if (t) {
        var self = this;
        t.columns.forEach(function (col, ri) {
          g.rowY[col.name] = pos.y + HEADER_H + ri * ROW_H + ROW_H / 2;
        });
      }
    }
    var elT = this._tableEls[key];
    if (elT) elT.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');
    this._redrawEdgesFor(key);
  };

  // redraw only the edges touching one table (fast path while dragging)
  Diagram.prototype._redrawEdgesFor = function (key) {
    var self = this;
    var keep = [];
    var stale = [];
    this._edgeEls.forEach(function (e) {
      if (e.ref.from.table === key || e.ref.to.table === key) stale.push(e);
      else keep.push(e);
    });
    if (stale.length > 50) {
      // hub table with tons of edges: full redraw is simpler
      this._redrawEdges();
      return;
    }
    stale.forEach(function (e) {
      if (e.grp.parentNode) e.grp.parentNode.removeChild(e.grp);
    });
    this._edgeEls = keep;
    var visible = {};
    this.visibleKeys().forEach(function (k) { visible[k] = true; });
    stale.forEach(function (e) {
      var r = e.ref;
      if (!visible[r.from.table] || !visible[r.to.table]) return;
      if (self.focused && r.from.table !== self.focused && r.to.table !== self.focused) return;
      self._renderEdge(r, -1);
    });
    if (this._hoverKey) this._applyHover();
  };

  Diagram.prototype._redrawEdges = function () {
    var self = this;
    this.edgeLayer.innerHTML = '';
    this._edgeEls = [];
    var visible = {};
    this.visibleKeys().forEach(function (k) { visible[k] = true; });
    this.model.refs.forEach(function (r, i) {
      if (!visible[r.from.table] || !visible[r.to.table]) return;
      if (self.focused && r.from.table !== self.focused && r.to.table !== self.focused) return;
      self._renderEdge(r, i);
    });
    if (this._hoverKey) this._applyHover();
  };

  Diagram.prototype._findTable = function (key) {
    for (var i = 0; i < this.model.tables.length; i++) {
      if (this.model.tables[i].key === key) return this.model.tables[i];
    }
    return null;
  };

  // ---------------- hover / select ----------------

  Diagram.prototype._hover = function (key) {
    this._hoverKey = key;
    this._applyHover();
  };

  Diagram.prototype._applyHover = function () {
    var key = this._hoverKey;
    var related = key ? this.relatedTables(key) : [];
    var relSet = {};
    related.forEach(function (k) { relSet[k] = true; });

    this._edgeEls.forEach(function (e) {
      var touches = key && (e.ref.from.table === key || e.ref.to.table === key);
      e.grp.classList.toggle('hl', !!touches);
      e.grp.classList.toggle('dim', !!key && !touches);
    });
    for (var k in this._tableEls) {
      var dim = key && k !== key && !relSet[k];
      this._tableEls[k].classList.toggle('dim', !!dim);
    }
  };

  Diagram.prototype.select = function (key) {
    this.selected = key;
    for (var k in this._tableEls) {
      this._tableEls[k].classList.toggle('selected', k === key);
    }
    if (this.callbacks.onSelect) this.callbacks.onSelect(key);
  };

  // ---------------- focus mode ----------------

  Diagram.prototype.focus = function (key) {
    if (!this._findTable(key)) return;
    if (!this.focused) {
      // save layout to restore later
      this.savedPositions = JSON.parse(JSON.stringify(this.positions));
      this.savedView = { scale: this.scale, tx: this.tx, ty: this.ty };
    }
    this.focused = key;
    this.selected = key;

    var self = this;

    // classify neighbors by FK direction:
    //   incoming = tables holding a FK that references the focused table
    //   outgoing = tables the focused table references
    var incoming = {}, outgoing = {};
    this.model.refs.forEach(function (r) {
      if (r.from.table === r.to.table) return;
      var fkT = r.op === '<' ? r.to.table : r.from.table;
      var refdT = r.op === '<' ? r.from.table : r.to.table;
      if (refdT === key && fkT !== key) incoming[fkT] = true;
      if (fkT === key && refdT !== key) outgoing[refdT] = true;
    });
    // tables related in both directions: show once, on the left
    Object.keys(incoming).forEach(function (k) {
      if (outgoing[k]) delete outgoing[k];
    });

    function toItem(k) {
      var t = self._findTable(k);
      if (!t) return null;
      var s = self._sizeOf(t);
      return { key: k, w: s.w, h: s.h };
    }
    var leftItems = Object.keys(incoming).map(toItem).filter(Boolean);
    var rightItems = Object.keys(outgoing).map(toItem).filter(Boolean);

    var centerT = this._findTable(key);
    var centerSize = this._sizeOf(centerT);
    var layout = window.DBV.focusLayout(
      { key: key, w: centerSize.w, h: centerSize.h },
      leftItems,
      rightItems
    );
    for (var k in layout) this.positions[k] = layout[k];

    this._focusMeta = {
      key: key,
      left: leftItems.map(function (i) { return i.key; }),
      right: rightItems.map(function (i) { return i.key; })
    };

    this.render();
    this.fitFocus();

    if (this.callbacks.onFocusChanged) {
      this.callbacks.onFocusChanged(key, {
        total: leftItems.length + rightItems.length,
        incoming: leftItems.length,
        outgoing: rightItems.length
      });
    }
  };

  // fit the focus neighborhood, but never zoom below a readable level —
  // when clamped, center the view on the focused table instead
  Diagram.prototype.fitFocus = function () {
    this.fit();
    var MIN_READABLE = 0.3;
    if (this.scale < MIN_READABLE && this.focused && this.geom[this.focused]) {
      var g = this.geom[this.focused];
      var rect = this.svg.getBoundingClientRect();
      this.scale = MIN_READABLE;
      this.tx = rect.width / 2 - (g.x + g.w / 2) * this.scale;
      this.ty = rect.height / 2 - (g.y + g.h / 2) * this.scale;
      this._applyViewTransform();
    }
  };

  // side block labels in focus mode
  Diagram.prototype._renderFocusLabels = function () {
    if (!this.focused || !this._focusMeta || this._focusMeta.key !== this.focused) return;
    var self = this;
    var meta = this._focusMeta;

    function bboxOf(keys) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity;
      keys.forEach(function (k) {
        var g = self.geom[k];
        if (!g) return;
        if (g.x < minX) minX = g.x;
        if (g.y < minY) minY = g.y;
        if (g.x + g.w > maxX) maxX = g.x + g.w;
      });
      return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX };
    }
    function label(text, bb) {
      var t = el('text', {
        class: 'side-label',
        x: bb.x + bb.w / 2,
        y: bb.y - 28,
        'text-anchor': 'middle'
      }, self.labelLayer);
      t.textContent = text;
    }

    var lb = bboxOf(meta.left);
    if (lb) label(meta.left.length + ' referencing \u201C' + meta.key + '\u201D \u2192', lb);
    var rb = bboxOf(meta.right);
    if (rb) label('\u201C' + meta.key + '\u201D references ' + meta.right.length + ' \u2192', rb);
  };

  Diagram.prototype.clearFocus = function (skipRender) {
    if (!this.focused) return;
    this.focused = null;
    this._focusMeta = null;
    if (this.savedPositions) {
      this.positions = this.savedPositions;
      this.savedPositions = null;
    }
    if (!skipRender) {
      this.render();
      if (this.savedView) {
        this.scale = this.savedView.scale;
        this.tx = this.savedView.tx;
        this.ty = this.savedView.ty;
        this.savedView = null;
        this._applyViewTransform();
      } else {
        this.fit();
      }
    }
    if (this.callbacks.onFocusChanged) this.callbacks.onFocusChanged(null, 0);
  };

  // ---------------- pan & zoom ----------------

  Diagram.prototype._bindPanZoom = function () {
    var self = this;
    var pan = null;

    this.svg.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('g.tbl-g')) return;
      pan = { sx: ev.clientX, sy: ev.clientY, ox: self.tx, oy: self.ty };
      self.svg.setPointerCapture(ev.pointerId);
      self.svg.style.cursor = 'grabbing';
    });
    this.svg.addEventListener('pointermove', function (ev) {
      if (!pan) return;
      self.tx = pan.ox + (ev.clientX - pan.sx);
      self.ty = pan.oy + (ev.clientY - pan.sy);
      self._applyViewTransform();
    });
    this.svg.addEventListener('pointerup', function () {
      pan = null;
      self.svg.style.cursor = '';
    });

    this.svg.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = self.svg.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var my = ev.clientY - rect.top;
      var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      self.zoomAt(mx, my, factor);
    }, { passive: false });

    this.svg.addEventListener('dblclick', function (ev) {
      if (ev.target.closest && ev.target.closest('g.tbl-g')) return;
      if (self.focused) self.clearFocus();
    });
  };

  // minimum scale: allow zooming out until whole diagram is ~25% of viewport,
  // with an absolute floor so it never locks up on huge schemas
  Diagram.prototype._minScale = function () {
    var bb = this.contentBBox();
    if (!bb) return 0.02;
    var rect = this.svg.getBoundingClientRect();
    var fitScale = Math.min(
      rect.width / Math.max(bb.w, 1),
      rect.height / Math.max(bb.h, 1)
    );
    return Math.max(0.002, Math.min(0.12, fitScale * 0.25));
  };

  Diagram.prototype.zoomAt = function (mx, my, factor) {
    var ns = Math.min(3, Math.max(this._minScale(), this.scale * factor));
    factor = ns / this.scale;
    this.tx = mx - (mx - this.tx) * factor;
    this.ty = my - (my - this.ty) * factor;
    this.scale = ns;
    this._applyViewTransform();
  };

  Diagram.prototype.zoomCenter = function (factor) {
    var rect = this.svg.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, factor);
  };

  Diagram.prototype._applyViewTransform = function () {
    this.viewport.setAttribute(
      'transform',
      'translate(' + this.tx + ',' + this.ty + ') scale(' + this.scale + ')'
    );
    if (this.callbacks.onZoom) this.callbacks.onZoom(this.scale);
  };

  Diagram.prototype.contentBBox = function () {
    var keys = this.visibleKeys();
    if (!keys.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var self = this;
    keys.forEach(function (k) {
      var g = self.geom[k];
      if (!g) return;
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.w);
      maxY = Math.max(maxY, g.y + g.h);
    });
    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  Diagram.prototype.fit = function () {
    var bb = this.contentBBox();
    if (!bb) return;
    var rect = this.svg.getBoundingClientRect();
    var pad = 60;
    var s = Math.min(
      (rect.width - pad * 2) / Math.max(bb.w, 1),
      (rect.height - pad * 2) / Math.max(bb.h, 1)
    );
    s = Math.min(1.25, Math.max(0.002, s));
    this.scale = s;
    this.tx = (rect.width - bb.w * s) / 2 - bb.x * s;
    this.ty = (rect.height - bb.h * s) / 2 - bb.y * s;
    this._applyViewTransform();
  };

  // ---------------- auto layout ----------------

  Diagram.prototype.runAutoLayout = function () {
    var self = this;
    if (this.focused) {
      // re-run radial layout in focus mode
      this.focus(this.focused);
      return;
    }
    var items = this.model.tables.map(function (t) {
      var s = self._sizeOf(t);
      return { key: t.key, w: s.w, h: s.h };
    });
    var edges = this.model.refs.map(function (r) {
      return { from: r.from.table, to: r.to.table };
    });
    this.positions = window.DBV.autoLayout(items, edges);
    this.render();
    if (this.callbacks.onPositionsChanged) this.callbacks.onPositionsChanged();
  };

  // ---------------- export ----------------

  Diagram.prototype.exportSVG = function () {
    var bb = this.contentBBox();
    if (!bb) return null;
    var pad = 40;
    var clone = this.svg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', bb.w + pad * 2);
    clone.setAttribute('height', bb.h + pad * 2);
    clone.setAttribute('viewBox', (bb.x - pad) + ' ' + (bb.y - pad) + ' ' + (bb.w + pad * 2) + ' ' + (bb.h + pad * 2));
    var vp = clone.querySelector('g.viewport');
    if (vp) vp.removeAttribute('transform');
    // background
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', bb.x - pad);
    bg.setAttribute('y', bb.y - pad);
    bg.setAttribute('width', bb.w + pad * 2);
    bg.setAttribute('height', bb.h + pad * 2);
    bg.setAttribute('fill', '#16181d');
    clone.insertBefore(bg, clone.querySelector('g.viewport'));
    return new XMLSerializer().serializeToString(clone);
  };

  Diagram.prototype.exportPNG = function (cb) {
    var svgStr = this.exportSVG();
    if (!svgStr) return cb(null);
    var bb = this.contentBBox();
    var pad = 40;
    var scale = 2;
    var img = new Image();
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = (bb.w + pad * 2) * scale;
      canvas.height = (bb.h + pad * 2) * scale;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(cb, 'image/png');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
  };

  window.DBV = window.DBV || {};
  window.DBV.Diagram = Diagram;
})();
