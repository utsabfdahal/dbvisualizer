/**
 * Data Viewer — wires SQL parsing, table navigation, data grid,
 * filtering, sorting, pagination, and CSV export.
 */
(function () {
  'use strict';

  // ---- DOM refs ----
  var fileInput     = document.getElementById('file-input');
  var fileSelect    = document.getElementById('file-select');
  var filePicker    = document.getElementById('file-picker');
  var btnRemoveFile = document.getElementById('btn-remove-file');
  var emptyImport   = document.getElementById('empty-import');
  var tableSearch   = document.getElementById('table-search');
  var sidebarNav    = document.getElementById('table-nav');
  var tableCountEl  = document.getElementById('table-count');
  var emptyState    = document.getElementById('empty-state');
  var tableView     = document.getElementById('table-view');
  var tableNameEl   = document.getElementById('table-name');
  var rowCountEl    = document.getElementById('row-count');
  var colCountEl    = document.getElementById('col-count');
  var dataSearch    = document.getElementById('data-search');
  var gridHead      = document.getElementById('grid-head');
  var gridBody      = document.getElementById('grid-body');
  var btnPrev       = document.getElementById('btn-prev');
  var btnNext       = document.getElementById('btn-next');
  var pageInfo      = document.getElementById('page-info');
  var pageSizeEl    = document.getElementById('page-size');
  var showingInfo   = document.getElementById('showing-info');
  var btnExportCSV  = document.getElementById('btn-export-csv');

  // ---- State ----
  var allTables     = [];   // parsed table objects
  var activeTable   = null; // currently displayed table
  var filteredRows  = [];   // rows after filter
  var sortCol       = -1;
  var sortAsc       = true;
  var currentPage   = 0;

  function getPageSize() {
    return parseInt(pageSizeEl.value, 10) || 50;
  }

  // ---- Cached files (localStorage) ----
  var LS_INDEX  = 'dbv.dv.index';    // [{ id, name, size, addedAt }]
  var LS_ACTIVE = 'dbv.dv.active';   // active file id
  var LS_FILE   = 'dbv.dv.file.';    // per-file SQL text, keyed by id

  function readIndex() {
    try { return JSON.parse(localStorage.getItem(LS_INDEX)) || []; }
    catch (e) { return []; }
  }
  function writeIndex(idx) {
    try { localStorage.setItem(LS_INDEX, JSON.stringify(idx)); } catch (e) { /* ignore */ }
  }
  function getActiveId() {
    try { return localStorage.getItem(LS_ACTIVE); } catch (e) { return null; }
  }
  function setActiveId(id) {
    try {
      if (id == null) localStorage.removeItem(LS_ACTIVE);
      else localStorage.setItem(LS_ACTIVE, id);
    } catch (e) { /* ignore */ }
  }
  function readFileSQL(id) {
    try { return localStorage.getItem(LS_FILE + id); } catch (e) { return null; }
  }

  // Save (or replace by name) a file in the cache. Returns its id, or null on failure.
  function cacheFile(name, sql) {
    var idx = readIndex();
    var existing = null;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].name === name) { existing = idx[i]; break; }
    }
    var id = existing ? existing.id
      : ('f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    try {
      localStorage.setItem(LS_FILE + id, sql);
    } catch (e) {
      return null; // quota exceeded
    }
    if (existing) {
      existing.size = sql.length;
      existing.addedAt = Date.now();
    } else {
      idx.push({ id: id, name: name, size: sql.length, addedAt: Date.now() });
    }
    writeIndex(idx);
    return id;
  }

  function removeCachedFile(id) {
    var idx = readIndex().filter(function (f) { return f.id !== id; });
    writeIndex(idx);
    try { localStorage.removeItem(LS_FILE + id); } catch (e) { /* ignore */ }
    return idx;
  }

  function refreshFilePicker() {
    var idx = readIndex();
    fileSelect.innerHTML = '';
    if (idx.length === 0) {
      filePicker.classList.add('hidden');
      return;
    }
    filePicker.classList.remove('hidden');
    var active = getActiveId();
    idx.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      if (f.id === active) opt.selected = true;
      fileSelect.appendChild(opt);
    });
  }

  // ---- Load parsed SQL into the viewer ----
  function loadSQL(sql) {
    var result = window.DBV.parseSQLDump(sql);
    allTables = result.tables;
    buildFKMap();
    buildSidebar();
    if (allTables.length > 0) {
      selectTable(allTables[0].name);
    } else {
      showEmpty();
    }
  }

  // ---- File import ----
  fileInput.addEventListener('change', function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    if (!files.length) return;

    var pending = files.length;
    var lastCachedId = null;
    var lastSQL = null;
    var uncached = false;

    files.forEach(function (file) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var sql = e.target.result;
        lastSQL = sql;
        var id = cacheFile(file.name, sql);
        if (id) lastCachedId = id;
        else uncached = true;

        if (--pending === 0) {
          refreshFilePicker();
          if (lastCachedId) {
            setActiveId(lastCachedId);
            fileSelect.value = lastCachedId;
            loadSQL(readFileSQL(lastCachedId));
          } else {
            loadSQL(lastSQL); // couldn't cache — load in memory only
          }
          if (uncached) {
            alert('Some files were too large to cache and were loaded without saving.');
          }
        }
      };
      reader.readAsText(file);
    });

    fileInput.value = ''; // allow re-importing the same file name
  });

  // ---- Switch between cached files ----
  fileSelect.addEventListener('change', function () {
    var id = fileSelect.value;
    setActiveId(id);
    var sql = readFileSQL(id);
    if (sql != null) loadSQL(sql);
  });

  // ---- Remove the selected cached file ----
  btnRemoveFile.addEventListener('click', function () {
    var id = fileSelect.value;
    if (!id) return;
    var idx = readIndex();
    var f = null;
    for (var i = 0; i < idx.length; i++) { if (idx[i].id === id) { f = idx[i]; break; } }
    if (f && !confirm('Remove "' + f.name + '" from cache?')) return;

    var remaining = removeCachedFile(id);
    if (remaining.length) {
      var nextId = remaining[0].id;
      setActiveId(nextId);
      refreshFilePicker();
      fileSelect.value = nextId;
      loadSQL(readFileSQL(nextId));
    } else {
      setActiveId(null);
      refreshFilePicker();
      allTables = [];
      buildSidebar();
      showEmpty();
    }
  });

  // ---- Import from the empty-state button ----
  if (emptyImport) {
    emptyImport.addEventListener('click', function () { fileInput.click(); });
  }

  // ---- Sidebar ----
  function buildSidebar() {
    sidebarNav.innerHTML = '';
    tableCountEl.textContent = allTables.length;

    allTables.forEach(function (tbl) {
      var li = document.createElement('li');
      li.dataset.table = tbl.name;

      var nameSpan = document.createElement('span');
      nameSpan.textContent = tbl.name;
      li.appendChild(nameSpan);

      var badge = document.createElement('span');
      badge.className = 'row-badge';
      badge.textContent = tbl.rows.length;
      badge.title = tbl.rows.length + ' rows';
      li.appendChild(badge);

      li.addEventListener('click', function () { selectTable(tbl.name); });
      sidebarNav.appendChild(li);
    });

    filterSidebar();
  }

  // ---- Table filter (sidebar) ----
  function filterSidebar() {
    var q = tableSearch.value.trim().toLowerCase();
    var items = sidebarNav.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      items[i].style.display =
        items[i].dataset.table.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    }
  }

  tableSearch.addEventListener('input', filterSidebar);

  tableSearch.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var items = sidebarNav.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      if (items[i].style.display !== 'none') {
        selectTable(items[i].dataset.table);
        tableSearch.blur();
        return;
      }
    }
  });

  // ---- Select table ----
  function selectTable(name) {
    activeTable = allTables.find(function (t) { return t.name === name; });
    if (!activeTable) return;

    // Update sidebar active state
    var items = sidebarNav.querySelectorAll('li');
    items.forEach(function (li) {
      li.classList.toggle('active', li.dataset.table === name);
    });

    // Reset state
    sortCol = -1;
    sortAsc = true;
    currentPage = 0;
    dataSearch.value = '';

    // Show view
    emptyState.classList.add('hidden');
    tableView.classList.remove('hidden');
    btnExportCSV.disabled = false;

    // Header info
    tableNameEl.textContent = activeTable.name;
    rowCountEl.textContent = activeTable.rows.length + ' rows';
    colCountEl.textContent = activeTable.columns.length + ' columns';

    buildGrid();
  }

  function showEmpty() {
    emptyState.classList.remove('hidden');
    tableView.classList.add('hidden');
    btnExportCSV.disabled = true;
  }

  // ---- Build grid ----
  function buildGrid() {
    if (!activeTable) return;

    // Head
    gridHead.innerHTML = '';
    var thIdx = document.createElement('th');
    thIdx.textContent = '#';
    gridHead.appendChild(thIdx);

    activeTable.columns.forEach(function (col, idx) {
      var th = document.createElement('th');
      var fk = getFKInfo(activeTable.name, col.name);

      var main = document.createElement('div');
      main.className = 'th-main';

      var nameEl = document.createElement('span');
      nameEl.className = 'col-name';
      nameEl.textContent = col.name;
      main.appendChild(nameEl);

      if (fk) {
        var fkEl = document.createElement('span');
        fkEl.className = 'fk-ref';
        fkEl.textContent = '→ ' + fk.refTable;
        fkEl.title = 'Go to ' + fk.refTable;
        fkEl.dataset.refTable = fk.refTable;
        fkEl.addEventListener('click', function (e) {
          e.stopPropagation(); // don't trigger sort
          selectTable(this.dataset.refTable);
        });
        main.appendChild(fkEl);
      }

      th.appendChild(main);

      if (col.type) {
        var typeEl = document.createElement('span');
        typeEl.className = 'col-type';
        typeEl.textContent = col.type;
        th.appendChild(typeEl);
      }

      th.title = col.name + (col.type ? ' · ' + col.type : '') +
        (fk ? '  ·  FK → ' + fk.refTable + '.' + fk.refColumn : '');

      th.addEventListener('click', function () {
        if (sortCol === idx) {
          sortAsc = !sortAsc;
        } else {
          sortCol = idx;
          sortAsc = true;
        }
        currentPage = 0;
        buildGrid();
      });
      gridHead.appendChild(th);
    });

    // Filter rows
    applyFilter();
  }

  // ---- Filter ----
  var filterTimer = null;
  dataSearch.addEventListener('input', function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      currentPage = 0;
      applyFilter();
    }, 200);
  });

  function applyFilter() {
    if (!activeTable) return;

    var q = dataSearch.value.trim().toLowerCase();
    if (!q) {
      filteredRows = activeTable.rows.slice();
    } else {
      filteredRows = activeTable.rows.filter(function (row) {
        for (var i = 0; i < row.length; i++) {
          if (row[i] !== null && String(row[i]).toLowerCase().indexOf(q) >= 0) return true;
        }
        return false;
      });
    }

    // Sort
    if (sortCol >= 0) {
      filteredRows.sort(function (a, b) {
        var va = a[sortCol], vb = b[sortCol];
        if (va === null && vb === null) return 0;
        if (va === null) return sortAsc ? -1 : 1;
        if (vb === null) return sortAsc ? 1 : -1;

        // Try numeric comparison
        var na = parseFloat(va), nb = parseFloat(vb);
        if (!isNaN(na) && !isNaN(nb)) {
          return sortAsc ? na - nb : nb - na;
        }

        // String comparison
        va = String(va).toLowerCase();
        vb = String(vb).toLowerCase();
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
      });
    }

    renderPage();
  }

  // ---- Pagination ----
  function renderPage() {
    var pageSize = getPageSize();
    var totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    if (currentPage < 0) currentPage = 0;

    var start = currentPage * pageSize;
    var end = Math.min(start + pageSize, filteredRows.length);
    var pageRows = filteredRows.slice(start, end);

    // Render body
    gridBody.innerHTML = '';
    pageRows.forEach(function (row, ri) {
      var tr = document.createElement('tr');

      // Row index
      var tdIdx = document.createElement('td');
      tdIdx.textContent = start + ri + 1;
      tdIdx.className = 'row-idx';
      tr.appendChild(tdIdx);

      for (var ci = 0; ci < activeTable.columns.length; ci++) {
        var td = document.createElement('td');
        var val = ci < row.length ? row[ci] : null;
        var colName = activeTable.columns[ci].name;
        var fkInfo = getFKInfo(activeTable.name, colName);

        if (val === null) {
          td.textContent = 'NULL';
          td.className = 'null-val';
        } else if (fkInfo) {
          // Render as clickable FK link
          var link = document.createElement('a');
          link.textContent = val;
          link.href = '#';
          link.className = 'fk-link';
          link.title = 'Go to ' + fkInfo.refTable + ' where ' + fkInfo.refColumn + ' = ' + val;
          link.dataset.refTable = fkInfo.refTable;
          link.dataset.refColumn = fkInfo.refColumn;
          link.dataset.val = val;
          link.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            navigateToFK(this.dataset.refTable, this.dataset.refColumn, this.dataset.val);
          });
          td.appendChild(link);
          if (isNumeric(val)) td.classList.add('num-val');
        } else {
          td.textContent = val;
          // Detect type for styling
          if (isNumeric(val)) {
            td.className = 'num-val';
          } else if (isDateLike(val)) {
            td.className = 'date-val';
          }
        }
        td.title = val === null ? 'NULL' : String(val);
        tr.appendChild(td);
      }

      gridBody.appendChild(tr);
    });

    // Pagination controls
    btnPrev.disabled = currentPage <= 0;
    btnNext.disabled = currentPage >= totalPages - 1;
    pageInfo.textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages;

    // Footer
    if (filteredRows.length === activeTable.rows.length) {
      showingInfo.textContent = 'Showing ' + (start + 1) + '–' + end + ' of ' + filteredRows.length + ' rows';
    } else {
      showingInfo.textContent = 'Showing ' + (start + 1) + '–' + end + ' of ' + filteredRows.length + ' filtered rows (' + activeTable.rows.length + ' total)';
    }

    // Update sort arrows in header
    var ths = gridHead.querySelectorAll('th');
    ths.forEach(function (th, idx) {
      var existing = th.querySelector('.sort-arrow');
      if (existing) existing.remove();
      if (sortCol >= 0 && idx - 1 === sortCol) { // idx-1 because first th is #
        var arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.textContent = sortAsc ? '▲' : '▼';
        (th.querySelector('.th-main') || th).appendChild(arrow);
      }
    });
  }

  btnPrev.addEventListener('click', function () {
    if (currentPage > 0) { currentPage--; renderPage(); }
  });
  btnNext.addEventListener('click', function () {
    currentPage++;
    renderPage();
  });
  pageSizeEl.addEventListener('change', function () {
    currentPage = 0;
    renderPage();
  });

  // ---- Helpers ----
  function isNumeric(v) {
    if (v === '' || v === null) return false;
    return !isNaN(v) && !isNaN(parseFloat(v));
  }

  function isDateLike(v) {
    if (!v || v.length < 10) return false;
    return /^\d{4}-\d{2}-\d{2}/.test(v);
  }

  // ---- CSV export ----
  btnExportCSV.addEventListener('click', function () {
    if (!activeTable) return;

    var lines = [];
    // Header
    lines.push(activeTable.columns.map(function (c) {
      return csvEscape(c.name);
    }).join(','));

    // Rows (all, not just current page)
    activeTable.rows.forEach(function (row) {
      var vals = [];
      for (var i = 0; i < activeTable.columns.length; i++) {
        vals.push(csvEscape(i < row.length ? row[i] : null));
      }
      lines.push(vals.join(','));
    });

    var csv = lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = activeTable.name + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  });

  // ---- FK navigation ----
  // Build a lookup: tableName -> columnName -> { refTable, refColumn }
  var fkMap = {};

  function buildFKMap() {
    fkMap = {};
    allTables.forEach(function (tbl) {
      if (!tbl.foreignKeys) return;
      tbl.foreignKeys.forEach(function (fk) {
        if (!fkMap[tbl.name]) fkMap[tbl.name] = {};
        fkMap[tbl.name][fk.column] = { refTable: fk.refTable, refColumn: fk.refColumn };
      });
    });
  }

  function getFKInfo(tableName, colName) {
    return fkMap[tableName] && fkMap[tableName][colName] || null;
  }

  function navigateToFK(refTable, refColumn, val) {
    // Find the referenced table
    var tbl = allTables.find(function (t) { return t.name === refTable; });
    if (!tbl) return;

    // Select the table
    selectTable(refTable);

    // Find the column index of refColumn and filter to matching value
    var colIdx = -1;
    for (var i = 0; i < tbl.columns.length; i++) {
      if (tbl.columns[i].name === refColumn) { colIdx = i; break; }
    }
    if (colIdx >= 0) {
      dataSearch.value = val;
      // Apply a precise filter on the referenced column
      filteredRows = tbl.rows.filter(function (row) {
        return colIdx < row.length && row[colIdx] !== null && String(row[colIdx]) === String(val);
      });
      currentPage = 0;
      renderPage();
    }
  }

  function csvEscape(val) {
    if (val === null || val === undefined) return '';
    var s = String(val);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ---- Boot: restore cached files ----
  (function boot() {
    refreshFilePicker();
    var idx = readIndex();
    if (!idx.length) { showEmpty(); return; }

    var active = getActiveId();
    var found = false;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].id === active) { found = true; break; }
    }
    if (!found) { active = idx[0].id; setActiveId(active); }

    var sql = readFileSQL(active);
    if (sql != null) {
      fileSelect.value = active;
      loadSQL(sql);
    } else {
      showEmpty();
    }
  })();
})();
