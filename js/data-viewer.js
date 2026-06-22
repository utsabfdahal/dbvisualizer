/**
 * Data Viewer — wires SQL parsing, table navigation, data grid,
 * filtering, sorting, pagination, and CSV export.
 */
(function () {
  'use strict';

  // ---- DOM refs ----
  var fileInput     = document.getElementById('file-input');
  var tableSearch   = document.getElementById('table-search');
  var datalistEl    = document.getElementById('table-list');
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

  // ---- File import ----
  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var sql = e.target.result;
      var result = window.DBV.parseSQLDump(sql);
      allTables = result.tables;
      buildFKMap();
      buildSidebar();
      if (allTables.length > 0) {
        selectTable(allTables[0].name);
      } else {
        showEmpty();
      }
    };
    reader.readAsText(file);
  });

  // ---- Sidebar ----
  function buildSidebar() {
    sidebarNav.innerHTML = '';
    datalistEl.innerHTML = '';
    tableCountEl.textContent = allTables.length;

    allTables.forEach(function (tbl) {
      // sidebar item
      var li = document.createElement('li');
      li.dataset.table = tbl.name;

      var nameSpan = document.createElement('span');
      nameSpan.textContent = tbl.name;
      li.appendChild(nameSpan);

      var badge = document.createElement('span');
      badge.className = 'row-badge';
      badge.textContent = tbl.rows.length + ' rows';
      li.appendChild(badge);

      li.addEventListener('click', function () { selectTable(tbl.name); });
      sidebarNav.appendChild(li);

      // datalist option
      var opt = document.createElement('option');
      opt.value = tbl.name;
      datalistEl.appendChild(opt);
    });
  }

  // ---- Table search ----
  tableSearch.addEventListener('input', function () {
    var q = tableSearch.value.trim().toLowerCase();
    var items = sidebarNav.querySelectorAll('li');
    items.forEach(function (li) {
      li.style.display = li.dataset.table.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    });
  });

  tableSearch.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var q = tableSearch.value.trim().toLowerCase();
      var match = allTables.find(function (t) {
        return t.name.toLowerCase() === q;
      });
      if (match) {
        selectTable(match.name);
        tableSearch.blur();
      }
    }
  });

  tableSearch.addEventListener('change', function () {
    var q = tableSearch.value.trim().toLowerCase();
    var match = allTables.find(function (t) {
      return t.name.toLowerCase() === q;
    });
    if (match) selectTable(match.name);
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
    thIdx.style.width = '50px';
    gridHead.appendChild(thIdx);

    activeTable.columns.forEach(function (col, idx) {
      var th = document.createElement('th');
      var fk = getFKInfo(activeTable.name, col.name);
      th.textContent = col.name;
      th.title = col.type + (fk ? '  ·  FK → ' + fk.refTable + '.' + fk.refColumn : '');
      if (fk) {
        var fkBtn = document.createElement('button');
        fkBtn.className = 'fk-header-btn';
        fkBtn.textContent = '→ ' + fk.refTable;
        fkBtn.title = 'Go to ' + fk.refTable;
        fkBtn.dataset.refTable = fk.refTable;
        fkBtn.addEventListener('click', function (e) {
          e.stopPropagation(); // don't trigger sort
          selectTable(this.dataset.refTable);
        });
        th.appendChild(fkBtn);
      }
      if (idx === sortCol) {
        var arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.textContent = sortAsc ? '▲' : '▼';
        th.appendChild(arrow);
      }
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
      tdIdx.style.color = 'var(--text-dim)';
      tdIdx.style.fontWeight = '600';
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
      if (idx - 1 === sortCol) { // idx-1 because first th is #
        var arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.textContent = sortAsc ? '▲' : '▼';
        th.appendChild(arrow);
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
})();
