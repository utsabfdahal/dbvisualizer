/**
 * Graph tools for large-schema exploration — pure, model-driven helpers.
 *
 * Operates on the parser model: { tables:[{key,name,schema,note,columns[]}],
 * refs:[{op,from:{table,column},to:{table,column},name?}], enums:[{name,values}],
 * groups:[{name,tables[]}] }.
 *
 * Exposes window.DBV.GraphTools(model) -> {
 *   search(query, limit), shortestPath(a,b), neighborhood(key,{depth,direction}),
 *   backbone(keys,minDegree), computeGroups(mode), degree(key), groupModes()
 * }
 */
(function () {
  'use strict';

  function GraphTools(model) {
    this.model = model || { tables: [], refs: [], enums: [], groups: [] };
    this._build();
  }

  GraphTools.prototype._build = function () {
    var self = this;
    var tables = this.model.tables || [];
    var refs = this.model.refs || [];

    this.tableByKey = {};
    tables.forEach(function (t) { self.tableByKey[t.key] = t; });

    // undirected adjacency + directed dependency edges
    // dependency direction: FK holder --depends on--> referenced table
    this.adj = {};       // key -> { neighborKey: true }  (undirected)
    this.dependsOn = {}; // key -> { key it references }
    this.dependedBy = {}; // key -> { key that references it }
    this._degree = {};

    tables.forEach(function (t) {
      self.adj[t.key] = {};
      self.dependsOn[t.key] = {};
      self.dependedBy[t.key] = {};
      self._degree[t.key] = 0;
    });

    refs.forEach(function (r) {
      var a = r.from && r.from.table;
      var b = r.to && r.to.table;
      if (!a || !b || a === b) return;
      if (!self.adj[a] || !self.adj[b]) return;

      self.adj[a][b] = true;
      self.adj[b][a] = true;

      // resolve which side holds the FK / depends on the other
      var holder, referenced;
      if (r.op === '<') { holder = b; referenced = a; }
      else { holder = a; referenced = b; } // '>', '-', '<>' default: from depends on to

      self.dependsOn[holder][referenced] = true;
      self.dependedBy[referenced][holder] = true;
    });

    tables.forEach(function (t) {
      self._degree[t.key] = Object.keys(self.adj[t.key]).length;
    });

    this._buildSearchRecords();
  };

  GraphTools.prototype.degree = function (key) {
    return this._degree[key] || 0;
  };

  // ---------------- search ----------------

  GraphTools.prototype._buildSearchRecords = function () {
    var recs = [];
    var self = this;

    (this.model.tables || []).forEach(function (t) {
      recs.push({ kind: 'table', label: t.name, sub: t.schema || '', tableKey: t.key, text: t.name });
      if (t.note) {
        recs.push({ kind: 'note', label: t.name, sub: t.note, tableKey: t.key, text: t.note });
      }
      (t.columns || []).forEach(function (c) {
        recs.push({ kind: 'column', label: c.name, sub: t.name + ' · ' + (c.type || ''), tableKey: t.key, text: c.name });
        if (c.note) {
          recs.push({ kind: 'note', label: t.name + '.' + c.name, sub: c.note, tableKey: t.key, text: c.note });
        }
      });
    });

    (this.model.enums || []).forEach(function (en) {
      recs.push({ kind: 'enum', label: en.name, sub: (en.values || []).join(', '), tableKey: null, text: en.name + ' ' + (en.values || []).join(' ') });
    });

    (this.model.refs || []).forEach(function (r) {
      var from = (r.from && r.from.table) || '';
      var to = (r.to && r.to.table) || '';
      var label = r.name || (from + ' ' + (r.op || '-') + ' ' + to);
      recs.push({ kind: 'relationship', label: label, sub: from + ' → ' + to, tableKey: from, text: label + ' ' + from + ' ' + to });
    });

    (this.model.groups || []).forEach(function (g) {
      recs.push({ kind: 'group', label: g.name, sub: (g.tables || []).length + ' tables', tableKey: null, text: g.name });
    });

    this._records = recs;
  };

  // Subsequence fuzzy score: higher is better, -1 = no match.
  function fuzzyScore(query, text) {
    if (!query) return 0;
    var q = query.toLowerCase();
    var s = text.toLowerCase();

    var exact = s.indexOf(q);
    if (exact >= 0) {
      // strong bonus for exact substring, extra for start-of-string/word
      var boundary = exact === 0 || /[^a-z0-9]/.test(s[exact - 1]);
      return 1000 - exact + (boundary ? 200 : 0) + Math.max(0, 60 - s.length);
    }

    // subsequence match
    var qi = 0, score = 0, prev = -2;
    for (var si = 0; si < s.length && qi < q.length; si++) {
      if (s[si] === q[qi]) {
        var boundaryChar = si === 0 || /[^a-z0-9]/.test(s[si - 1]);
        score += 10;
        if (si === prev + 1) score += 8;     // consecutive
        if (boundaryChar) score += 6;         // word start
        prev = si;
        qi++;
      }
    }
    if (qi < q.length) return -1;
    return score + Math.max(0, 30 - s.length);
  }

  GraphTools.prototype.search = function (query, limit) {
    query = (query || '').trim();
    if (!query) return [];
    var results = [];
    for (var i = 0; i < this._records.length; i++) {
      var rec = this._records[i];
      var score = fuzzyScore(query, rec.label);
      var altScore = fuzzyScore(query, rec.text);
      score = Math.max(score, altScore - 20); // matching non-label text scores a bit lower
      if (score >= 0) {
        results.push({ rec: rec, score: score });
      }
    }
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.rec.label.length - b.rec.label.length;
    });
    return results.slice(0, limit || 30).map(function (r) { return r.rec; });
  };

  // ---------------- shortest path (undirected BFS) ----------------

  GraphTools.prototype.shortestPath = function (aKey, bKey) {
    if (aKey === bKey) return this.tableByKey[aKey] ? [aKey] : null;
    if (!this.adj[aKey] || !this.adj[bKey]) return null;

    var prev = {};
    var seen = {};
    var queue = [aKey];
    seen[aKey] = true;

    while (queue.length) {
      var cur = queue.shift();
      if (cur === bKey) {
        var path = [bKey];
        var node = bKey;
        while (node !== aKey) { node = prev[node]; path.push(node); }
        return path.reverse();
      }
      var nbrs = this.adj[cur];
      for (var nb in nbrs) {
        if (!seen[nb]) { seen[nb] = true; prev[nb] = cur; queue.push(nb); }
      }
    }
    return null; // disconnected
  };

  // ---------------- N-hop neighborhood / impact ----------------
  // direction: 'both' (default), 'out' = dependencies, 'in' = dependents
  GraphTools.prototype.neighborhood = function (key, opts) {
    opts = opts || {};
    var depth = opts.depth == null ? 1 : opts.depth;
    var direction = opts.direction || 'both';
    if (!this.adj[key]) return [];

    var maps = [];
    if (direction === 'both') maps = [this.adj];
    else if (direction === 'out') maps = [this.dependsOn];
    else if (direction === 'in') maps = [this.dependedBy];

    var level = {};
    level[key] = 0;
    var frontier = [key];
    var d = 0;
    while (frontier.length && d < depth) {
      var next = [];
      for (var i = 0; i < frontier.length; i++) {
        var cur = frontier[i];
        maps.forEach(function (m) {
          var nbrs = m[cur] || {};
          for (var nb in nbrs) {
            if (level[nb] == null) { level[nb] = d + 1; next.push(nb); }
          }
        });
      }
      frontier = next;
      d++;
    }
    return Object.keys(level);
  };

  // ---------------- backbone filter ----------------
  // keep only tables whose undirected degree (within the given key set) >= minDegree
  GraphTools.prototype.backbone = function (keys, minDegree) {
    var self = this;
    if (minDegree <= 0) return keys.slice();
    var set = {};
    keys.forEach(function (k) { set[k] = true; });
    return keys.filter(function (k) {
      var nbrs = self.adj[k] || {};
      var deg = 0;
      for (var nb in nbrs) { if (set[nb]) deg++; }
      return deg >= minDegree;
    });
  };

  // ---------------- grouping ----------------

  GraphTools.prototype.groupModes = function () {
    var modes = [];
    if ((this.model.groups || []).length) modes.push('tablegroup');
    if ((this.model.tables || []).some(function (t) { return t.schema; })) modes.push('schema');
    modes.push('prefix');
    return modes;
  };

  GraphTools.prototype._autoMode = function () {
    var modes = this.groupModes();
    return modes[0];
  };

  function tokenize(name) {
    return String(name).split(/[_\-]/).filter(Boolean);
  }

  // Group key from a table name. When many tables share a leading token
  // (e.g. "tbl_"), that token is stripped so grouping uses the next segment.
  function prefixGroupKey(name, stripToken) {
    var toks = tokenize(name);
    if (!toks.length) return 'other';
    if (stripToken && toks.length > 1 && toks[0].toLowerCase() === stripToken) {
      return toks[1];
    }
    return toks[0];
  }

  GraphTools.prototype.computeGroups = function (mode) {
    if (!mode || mode === 'auto') mode = this._autoMode();
    var tables = this.model.tables || [];
    var keyToGroup = {};
    var order = [];
    var map = {};

    function add(groupName, key) {
      if (!map[groupName]) { map[groupName] = { name: groupName, keys: [] }; order.push(groupName); }
      map[groupName].keys.push(key);
      keyToGroup[key] = groupName;
    }

    if (mode === 'tablegroup') {
      var inGroup = {};
      (this.model.groups || []).forEach(function (g) {
        (g.tables || []).forEach(function (tk) {
          // group members may be stored as name or key; match either
          inGroup[tk] = g.name;
        });
      });
      tables.forEach(function (t) {
        var gn = inGroup[t.key] || inGroup[t.name] || 'ungrouped';
        add(gn, t.key);
      });
    } else if (mode === 'schema') {
      tables.forEach(function (t) { add(t.schema || 'public', t.key); });
    } else { // prefix
      // detect a dominant leading token shared by most tables and skip it
      var counts = {};
      tables.forEach(function (t) {
        var toks = tokenize(t.name);
        if (toks.length) { var k = toks[0].toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
      });
      var dominant = null, maxc = 0;
      Object.keys(counts).forEach(function (k) { if (counts[k] > maxc) { maxc = counts[k]; dominant = k; } });
      var strip = (dominant && maxc > 1 && maxc >= tables.length * 0.5) ? dominant : null;
      tables.forEach(function (t) { add(prefixGroupKey(t.name, strip), t.key); });
    }

    var groups = order.map(function (n) { return map[n]; })
      .sort(function (a, b) { return b.keys.length - a.keys.length; });

    return { mode: mode, groups: groups, keyToGroup: keyToGroup };
  };

  window.DBV = window.DBV || {};
  window.DBV.GraphTools = GraphTools;
  window.DBV.fuzzyScore = fuzzyScore;
})();
