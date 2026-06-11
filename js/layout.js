/**
 * Force-directed auto layout for tables.
 * window.DBV.autoLayout(items, edges) -> { key: {x, y} }  (top-left positions)
 *   items: [{ key, w, h }]
 *   edges: [{ from, to }] (table keys)
 */
(function () {
  'use strict';

  function autoLayout(items, edges) {
    var n = items.length;
    if (n === 0) return {};

    // Large schemas: force simulation is O(n^2) per iteration — far too slow
    // beyond a few hundred tables. Use a connectivity-aware grid instead.
    if (n > 150) return gridLayout(items, edges);

    var nodes = items.map(function (it, idx) {
      return { key: it.key, w: it.w, h: it.h, x: 0, y: 0, vx: 0, vy: 0, idx: idx };
    });
    var index = {};
    nodes.forEach(function (nd) { index[nd.key] = nd; });

    // init on a circle, connected nodes seeded near each other via degree order
    var R = Math.max(220, n * 55);
    nodes.forEach(function (nd, idx) {
      var a = (idx / n) * Math.PI * 2;
      nd.x = Math.cos(a) * R + (Math.random() - 0.5) * 50;
      nd.y = Math.sin(a) * R * 0.7 + (Math.random() - 0.5) * 50;
    });

    var links = [];
    var seen = {};
    edges.forEach(function (e) {
      var a = index[e.from], b = index[e.to];
      if (!a || !b || a === b) return;
      var k = a.idx < b.idx ? a.idx + '-' + b.idx : b.idx + '-' + a.idx;
      if (seen[k]) return;
      seen[k] = true;
      links.push([a, b]);
    });

    var ITER = 350;
    for (var it = 0; it < ITER; it++) {
      var t = 1 - it / ITER;
      var step = 14 * t + 1;

      // repulsion (pairwise, fine for typical schema sizes)
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = b.x - a.x, dy = b.y - a.y;
          var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          var minD = (a.w + b.w) / 2 + (a.h + b.h) / 2; // size-aware spacing
          var force = (minD * minD * 0.9) / (dist * dist);
          if (force > 8) force = 8;
          var fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // attraction along edges
      links.forEach(function (l) {
        var a = l[0], b = l[1];
        var dx = b.x - a.x, dy = b.y - a.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var ideal = (a.w + b.w) / 2 + 110;
        var force = (dist - ideal) * 0.02;
        var fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });

      // gentle pull to center
      nodes.forEach(function (nd) {
        nd.vx -= nd.x * 0.0015;
        nd.vy -= nd.y * 0.0015;
        var v = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy) || 0.01;
        var cap = Math.min(v, step);
        nd.x += (nd.vx / v) * cap;
        nd.y += (nd.vy / v) * cap;
        nd.vx *= 0.55;
        nd.vy *= 0.55;
      });
    }

    // de-overlap pass (rect based)
    for (var pass = 0; pass < 60; pass++) {
      var moved = false;
      for (var i2 = 0; i2 < n; i2++) {
        for (var j2 = i2 + 1; j2 < n; j2++) {
          var p = nodes[i2], q = nodes[j2];
          var gapX = 46, gapY = 36;
          var ox = (p.w + q.w) / 2 + gapX - Math.abs(p.x - q.x);
          var oy = (p.h + q.h) / 2 + gapY - Math.abs(p.y - q.y);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox < oy) {
              var sx = p.x < q.x ? -1 : 1;
              p.x += (sx * ox) / 2;
              q.x -= (sx * ox) / 2;
            } else {
              var sy = p.y < q.y ? -1 : 1;
              p.y += (sy * oy) / 2;
              q.y -= (sy * oy) / 2;
            }
          }
        }
      }
      if (!moved) break;
    }

    var out = {};
    nodes.forEach(function (nd) {
      out[nd.key] = { x: Math.round(nd.x - nd.w / 2), y: Math.round(nd.y - nd.h / 2) };
    });
    return out;
  }

  /**
   * Fast O(n + e) layout for very large schemas:
   * BFS over the relation graph so connected tables end up adjacent,
   * then flow the ordering into rows of a roughly square grid.
   */
  function gridLayout(items, edges) {
    var index = {};
    items.forEach(function (it, i) { index[it.key] = i; });

    // adjacency
    var adj = items.map(function () { return []; });
    edges.forEach(function (e) {
      var a = index[e.from], b = index[e.to];
      if (a == null || b == null || a === b) return;
      adj[a].push(b);
      adj[b].push(a);
    });

    // order: BFS from highest-degree unvisited node, component by component
    var visited = new Array(items.length);
    var order = [];
    var byDegree = items
      .map(function (it, i) { return i; })
      .sort(function (a, b) { return adj[b].length - adj[a].length; });

    byDegree.forEach(function (start) {
      if (visited[start]) return;
      var queue = [start];
      visited[start] = true;
      while (queue.length) {
        var cur = queue.shift();
        order.push(cur);
        adj[cur].forEach(function (nb) {
          if (!visited[nb]) {
            visited[nb] = true;
            queue.push(nb);
          }
        });
      }
    });

    // flow into rows: aim for a roughly square overall aspect
    var GAP_X = 60, GAP_Y = 50;
    var avgW = 0;
    items.forEach(function (it) { avgW += it.w; });
    avgW = avgW / items.length + GAP_X;
    var cols = Math.max(1, Math.ceil(Math.sqrt(items.length * 1.4)));
    var rowMaxW = cols * avgW;

    var out = {};
    var x = 0, y = 0, rowH = 0;
    order.forEach(function (i) {
      var it = items[i];
      if (x > 0 && x + it.w > rowMaxW) {
        x = 0;
        y += rowH + GAP_Y;
        rowH = 0;
      }
      out[it.key] = { x: Math.round(x), y: Math.round(y) };
      x += it.w + GAP_X;
      if (it.h > rowH) rowH = it.h;
    });
    return out;
  }

  /**
   * Focus layout: focused table in the center. Tables that REFERENCE it are
   * stacked in compact multi-column blocks on the LEFT; tables it REFERENCES
   * go on the RIGHT. Each side wraps into roughly-square column blocks, so it
   * stays usable even when a hub table has 150+ relations.
   */
  function focusLayout(center, leftItems, rightItems) {
    var GAP_X = 90;        // gap between columns
    var GAP_Y = 30;        // gap between tables in a column
    var CENTER_GAP = 240;  // gap between focused table and first column

    var out = {};
    out[center.key] = { x: -center.w / 2, y: -center.h / 2 };

    function placeSide(items, dir) { // dir: -1 = left, +1 = right
      if (!items.length) return;
      items = items.slice().sort(function (a, b) {
        return a.key.localeCompare(b.key);
      });

      var sumH = 0, maxW = 0;
      items.forEach(function (it) {
        sumH += it.h;
        if (it.w > maxW) maxW = it.w;
      });
      var avgH = sumH / items.length + GAP_Y;
      var colW = maxW + GAP_X;

      // choose column count so each side block is roughly square
      var nCols = Math.max(1, Math.round(Math.sqrt((items.length * avgH) / colW)));
      var perCol = Math.ceil(items.length / nCols);

      var edgeX = dir * (center.w / 2 + CENTER_GAP); // inner edge of current column
      for (var c = 0; c * perCol < items.length; c++) {
        var colItems = items.slice(c * perCol, (c + 1) * perCol);
        var colWidth = 0, totalH = -GAP_Y;
        colItems.forEach(function (it) {
          if (it.w > colWidth) colWidth = it.w;
          totalH += it.h + GAP_Y;
        });
        var y = -totalH / 2;
        colItems.forEach(function (it) {
          out[it.key] = {
            x: Math.round(dir > 0 ? edgeX : edgeX - it.w),
            y: Math.round(y)
          };
          y += it.h + GAP_Y;
        });
        edgeX += dir * (colWidth + GAP_X);
      }
    }

    placeSide(leftItems, -1);
    placeSide(rightItems, 1);
    return out;
  }

  window.DBV = window.DBV || {};
  window.DBV.autoLayout = autoLayout;
  window.DBV.focusLayout = focusLayout;
})();
