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
    this.subset = null;        // array of keys when viewing a specific set of tables
    this.selected = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._edgeEls = [];
    this._tableEls = {};
    this._enumMap = {};

    // large-schema features
    this.groupColors = {};     // key -> color (group coloring)
    this.colorByGroup = false; // when true, header uses group color
    this.hiddenKeys = {};      // key -> true (hidden via group toggles)
    this.pathKeys = null;      // ordered keys of a highlighted relationship path
    this._lod = 'full';        // 'full' | 'header' | 'mini'
    this._revirtTimer = null;

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

    // compute centrality scores
    this._computeCentrality();

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
    if (this.subset) {
      this.subset = this.subset.filter(function (k) { return valid[k]; });
      if (!this.subset.length) this.clearFocus(true);
    }
    // prune hidden keys for tables that no longer exist
    Object.keys(this.hiddenKeys).forEach(function (k) {
      if (!valid[k]) delete self.hiddenKeys[k];
    });
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

  // ---------- centrality ----------

  Diagram.prototype._computeCentrality = function () {
    var self = this;
    this._centrality = {};
    this.model.tables.forEach(function (t) {
      self._centrality[t.key] = { incoming: 0, outgoing: 0, serviceUsage: 0, controllerUsage: 0, score: 0 };
    });
    this.model.refs.forEach(function (r) {
      var fk = r.from.table, ref = r.to.table;
      if (r.op === '>') {
        if (self._centrality[fk]) self._centrality[fk].outgoing++;
        if (self._centrality[ref]) self._centrality[ref].incoming++;
      } else if (r.op === '<') {
        if (self._centrality[ref]) self._centrality[ref].outgoing++;
        if (self._centrality[fk]) self._centrality[fk].incoming++;
      } else {
        if (self._centrality[fk]) self._centrality[fk].outgoing++;
        if (self._centrality[ref]) self._centrality[ref].incoming++;
      }
    });
    this.model.tables.forEach(function (t) {
      var s = t.settings || {};
      var su = parseInt(s.service_usage || '0', 10) || 0;
      var cu = parseInt(s.controller_usage || '0', 10) || 0;
      var c = self._centrality[t.key];
      c.serviceUsage = su;
      c.controllerUsage = cu;
      c.score = c.incoming + c.outgoing + c.serviceUsage + c.controllerUsage;
    });
  };

  Diagram.prototype._centralityColor = function (score) {
    if (score >= 8) return '#e3b341';
    if (score >= 5) return '#d4641c';
    if (score >= 3) return '#2f6feb';
    return '#5b6372';
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
    if (this.colorByGroup && this.groupColors[t.key]) return this.groupColors[t.key];
    var s = t.settings || {};
    var c = s.headercolor || s.color;
    if (c) return c;
    return PALETTE[idx % PALETTE.length];
  };

  // table keys visible under current focus
  Diagram.prototype.visibleKeys = function () {
    var self = this;
    if (this.subset) {
      return this.subset.filter(function (k) { return !!self._findTable(k); });
    }
    if (!this.focused) {
      return this.model.tables.filter(function (t) {
        return !self.hiddenKeys[t.key];
      }).map(function (t) { return t.key; });
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

  // Level of detail for the current zoom: full tables, header-only, or mini boxes.
  Diagram.prototype._lodForScale = function () {
    if (this.scale >= 0.5) return 'full';
    if (this.scale >= 0.18) return 'header';
    return 'mini';
  };

  // World-space viewport rectangle (with a one-screen margin) for culling.
  Diagram.prototype._viewportWorldRect = function (marginFactor) {
    var rect = this.svg.getBoundingClientRect();
    var mf = marginFactor == null ? 1 : marginFactor;
    var mx = (rect.width / this.scale) * mf;
    var my = (rect.height / this.scale) * mf;
    var x0 = (-this.tx) / this.scale - mx;
    var y0 = (-this.ty) / this.scale - my;
    var x1 = (rect.width - this.tx) / this.scale + mx;
    var y1 = (rect.height - this.ty) / this.scale + my;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  };

  Diagram.prototype.render = function () {
    this._layout();
    this._paint();
  };

  // Compute geometry for ALL visible tables (cheap arithmetic; needed for edges,
  // fit and bbox even when a table is culled from the DOM).
  Diagram.prototype._layout = function () {
    var self = this;
    this.geom = {};
    var visible = {};
    this.visibleKeys().forEach(function (k) { visible[k] = true; });
    this._visibleMap = visible;
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
  };

  // Build the DOM for the current view: viewport culling + level of detail.
  // Safe to call repeatedly after view changes without recomputing geometry.
  Diagram.prototype._paint = function () {
    var self = this;
    this.tableLayer.innerHTML = '';
    this.edgeLayer.innerHTML = '';
    this.labelLayer.innerHTML = '';
    this._tableEls = {};
    this._edgeEls = [];

    var visible = this._visibleMap || {};
    var visibleList = Object.keys(this.geom);

    var lod = this._lodForScale();
    this._lod = lod;

    // viewport culling is only worthwhile in the full overview
    var cull = !this.focused && !this.subset && visibleList.length > 60;
    var inView = {};
    if (cull) {
      var vr = this._viewportWorldRect(0.6);
      visibleList.forEach(function (k) {
        var g = self.geom[k];
        if (!g) return;
        if (g.x < vr.x1 && g.x + g.w > vr.x0 && g.y < vr.y1 && g.y + g.h > vr.y0) {
          inView[k] = true;
        }
      });
    } else {
      visibleList.forEach(function (k) { inView[k] = true; });
    }

    // edges (under tables) — draw when at least one endpoint is on screen
    this.model.refs.forEach(function (r, i) {
      if (!visible[r.from.table] || !visible[r.to.table]) return;
      if (self.focused && r.from.table !== self.focused && r.to.table !== self.focused) return;
      if (!inView[r.from.table] && !inView[r.to.table]) return;
      self._renderEdge(r, i, lod);
    });

    // tables (idx over the model keeps palette colors stable)
    this.model.tables.forEach(function (t, idx) {
      if (!visible[t.key] || !inView[t.key]) return;
      self._renderTable(t, idx, lod);
    });

    this._renderFocusLabels();
    this._applyViewTransform();

    if (this.pathKeys) this._highlightPathEdges(this.pathKeys);
    if (this._hoverKey) this._applyHover();
  };

  // Re-cull / re-LOD after the view moved (debounced to a frame). Geometry is
  // unchanged, so only a repaint is needed.
  Diagram.prototype._scheduleRevirtualize = function () {
    var self = this;
    if (this._revirtTimer) return;
    this._revirtTimer = requestAnimationFrame(function () {
      self._revirtTimer = null;
      self._paint();
    });
  };

  Diagram.prototype._renderTable = function (t, idx, lod) {
    var self = this;
    var g = this.geom[t.key];
    var grp = el('g', {
      class: 'tbl-g' + (this.selected === t.key ? ' selected' : ''),
      transform: 'translate(' + g.x + ',' + g.y + ')',
      'data-key': t.key
    }, this.tableLayer);

    var hdrColor = this._headerColor(t, idx);

    // ---- mini LOD: a single colored box, no text (fast overview) ----
    if (lod === 'mini') {
      el('rect', { class: 'tbl-box tbl-mini', width: g.w, height: g.h, rx: 6, fill: hdrColor }, grp);
      var mtip = el('title', null, grp);
      mtip.textContent = t.name;
      this._tableEls[t.key] = grp;
      this._bindTableEvents(grp, t.key);
      return;
    }

    // shadow + body
    el('rect', { class: 'tbl-box', width: g.w, height: g.h, rx: 8 }, grp);

    // header
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

    // ---- header LOD: name band only, skip rows/badge ----
    if (lod === 'header') {
      this._tableEls[t.key] = grp;
      this._bindTableEvents(grp, t.key);
      return;
    }

    // centrality score badge
    var cent = (this._centrality && this._centrality[t.key]) || { score: 0, incoming: 0, outgoing: 0, serviceUsage: 0, controllerUsage: 0 };
    if (cent.score > 0) {
      var label = String(cent.score);
      var bw = Math.max(22, measure(label, '600 9px sans-serif') + 12);
      var centColor = this._centralityColor(cent.score);
      el('rect', { class: 'badge', x: g.w - bw - 8, y: 9, width: bw, height: 16, rx: 8, fill: centColor, opacity: 0.85 }, grp);
      var bt = el('text', { class: 'badge-text', x: g.w - bw / 2 - 8, y: 20.5, 'text-anchor': 'middle', fill: '#fff' }, grp);
      bt.textContent = label;
      var centTip = el('title', null, bt.parentNode ? grp : bt);
      centTip.textContent = 'Centrality: ' + cent.score +
        '\nIncoming FKs: ' + cent.incoming +
        '\nOutgoing FKs: ' + cent.outgoing +
        '\nService usage: ' + cent.serviceUsage +
        '\nController usage: ' + cent.controllerUsage;
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

  Diagram.prototype._edgeAnchors = function (r, lod) {
    var a = this.geom[r.from.table];
    var b = this.geom[r.to.table];
    if (!a || !b) return null;

    var simple = lod && lod !== 'full';
    var ay = simple ? a.y + HEADER_H / 2
      : ((a.rowY && a.rowY[r.from.column] != null) ? a.rowY[r.from.column] : a.y + HEADER_H / 2);
    var by = simple ? b.y + HEADER_H / 2
      : ((b.rowY && b.rowY[r.to.column] != null) ? b.rowY[r.to.column] : b.y + HEADER_H / 2);

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

  Diagram.prototype._renderEdge = function (r, idx, lod) {
    lod = lod || this._lod || 'full';
    var pts = this._edgeAnchors(r, lod);
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

    // Simplified LOD: thin line only, no hit target / dots / labels / tooltip.
    if (lod !== 'full') {
      this._edgeEls.push({ grp: grp, ref: r });
      return;
    }

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
    // tables related in both directions (referencing AND referenced by the
    // focused table): show once, on the right — no matter what
    Object.keys(outgoing).forEach(function (k) {
      if (incoming[k]) delete incoming[k];
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
      this._paint();
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

  // Show only the given set of tables (by exact key) plus any relationships
  // that exist between them. Positions are kept from the overview layout.
  Diagram.prototype.showSubset = function (keys, missing, opts) {
    var self = this;
    opts = opts || {};
    var seen = {};
    var valid = [];
    (keys || []).forEach(function (k) {
      var t = self._findTable(k);
      if (t && !seen[t.key]) { seen[t.key] = true; valid.push(t.key); }
    });
    if (!valid.length) return { matched: [], missing: missing || keys || [] };

    // entering a view mode from the overview: back up the current view
    if (!this.focused && !this.subset) {
      this.savedView = { scale: this.scale, tx: this.tx, ty: this.ty };
    }
    // leaving focus mode (which relocates tables): restore the real layout first
    if (this.focused) {
      this.focused = null;
      this._focusMeta = null;
      if (this.savedPositions) {
        this.positions = this.savedPositions;
        this.savedPositions = null;
      }
    }

    this.subset = valid;
    this.selected = null;
    this.pathKeys = opts.pathHighlight ? valid.slice() : null;

    // count relationships wholly inside the subset
    var inSet = {};
    valid.forEach(function (k) { inSet[k] = true; });
    var relations = 0;
    this.model.refs.forEach(function (r) {
      if (r.from.table === r.to.table) return;
      if (inSet[r.from.table] && inSet[r.to.table]) relations++;
    });

    this.render();
    this.fit();

    if (opts.pathHighlight) this._highlightPathEdges(valid);

    if (this.callbacks.onSubsetChanged) {
      this.callbacks.onSubsetChanged(valid.slice(), {
        count: valid.length,
        relations: relations,
        missing: missing || [],
        label: opts.label || null
      });
    }
    return { matched: valid.slice(), missing: missing || [] };
  };

  // Highlight edges that connect consecutive tables along an ordered path.
  Diagram.prototype._highlightPathEdges = function (path) {
    var pairs = {};
    for (var i = 0; i < path.length - 1; i++) {
      pairs[path[i] + '\u0000' + path[i + 1]] = true;
      pairs[path[i + 1] + '\u0000' + path[i]] = true;
    }
    this._edgeEls.forEach(function (e) {
      var r = e.ref;
      if (pairs[r.from.table + '\u0000' + r.to.table]) e.grp.classList.add('hl');
    });
  };

  // ---- group coloring & visibility (large-schema features) ----
  Diagram.prototype.setGroupColors = function (map, enable) {
    this.groupColors = map || {};
    if (enable != null) this.colorByGroup = !!enable;
    this.render();
  };

  Diagram.prototype.setColorByGroup = function (enable) {
    this.colorByGroup = !!enable;
    this.render();
  };

  Diagram.prototype.setHiddenKeys = function (hiddenMap) {
    this.hiddenKeys = hiddenMap || {};
    if (this.focused) this.clearFocus(true);
    this.render();
    this.fit();
  };

  Diagram.prototype.clearFocus = function (skipRender) {
    if (!this.focused && !this.subset) return;
    this.focused = null;
    this.subset = null;
    this.pathKeys = null;
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
        this._paint();
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
      self._scheduleRevirtualize();
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
    this._scheduleRevirtualize();
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
    this._paint();
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
