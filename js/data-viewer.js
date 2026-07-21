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
  var sqlQuery      = document.getElementById('sql-query');
  var btnRunQuery   = document.getElementById('btn-run-query');
  var btnClearQuery = document.getElementById('btn-clear-query');
  var queryStatus   = document.getElementById('query-status');

  // ---- State ----
  var allTables     = [];   // parsed table objects
  var activeTable   = null; // currently displayed table
  var filteredRows  = [];   // rows after filter
  var sortCol       = -1;
  var sortAsc       = true;
  var currentPage   = 0;
  var queryDatabase = null; // AlaSQL database populated from the current dump
  var lastTableName = null; // last real table selected before showing query results
  var queryResultActive = false;

  function getPageSize() {
    return parseInt(pageSizeEl.value, 10) || 50;
  }

  function formatCount(count, singular) {
    return count + ' ' + singular + (count === 1 ? '' : 's');
  }

  // ---- Cached files: metadata in localStorage, contents in IndexedDB ----
  // localStorage keeps only tiny metadata (so it never hits the ~5MB quota);
  // the SQL text itself lives in IndexedDB, which handles much larger files.
  var LS_INDEX  = 'dbv.dv.index';    // [{ id, name, size, addedAt }]
  var LS_ACTIVE = 'dbv.dv.active';   // active file id
  var LS_FILE   = 'dbv.dv.file.';    // legacy localStorage blobs (migrated to IDB)

  var IDB_NAME  = 'dbv-dataviewer';
  var IDB_STORE = 'files';

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

  // ---- IndexedDB plumbing ----
  var dbPromise = null;
  function getDB() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function idbPut(id, sql) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(sql, id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB write aborted')); };
      });
    });
  }
  function idbGet(id) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result != null ? req.result : null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbDelete(id) {
    return getDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read file')); };
      reader.readAsText(file);
    });
  }

  // Read a file's SQL (IndexedDB first, falling back to any legacy localStorage blob).
  function readFileSQL(id) {
    function legacy() {
      try { return localStorage.getItem(LS_FILE + id); } catch (e) { return null; }
    }
    return idbGet(id).then(function (sql) {
      return sql != null ? sql : legacy();
    }, function () { return legacy(); });
  }

  // Save (or replace by name) a file. Resolves with its id, or null if it couldn't be stored.
  function cacheFile(name, sql) {
    var idx = readIndex();
    var existing = null;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].name === name) { existing = idx[i]; break; }
    }
    var id = existing ? existing.id
      : ('f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    return idbPut(id, sql).then(function () {
      if (existing) {
        existing.size = sql.length;
        existing.addedAt = Date.now();
      } else {
        idx.push({ id: id, name: name, size: sql.length, addedAt: Date.now() });
      }
      writeIndex(idx);
      return id;
    }, function (e) {
      console.error('Could not cache file', name, e);
      return null;
    });
  }

  // Remove a cached file. Resolves with the remaining index.
  function removeCachedFile(id) {
    var idx = readIndex().filter(function (f) { return f.id !== id; });
    writeIndex(idx);
    try { localStorage.removeItem(LS_FILE + id); } catch (e) { /* ignore */ }
    return idbDelete(id).then(function () { return idx; }, function () { return idx; });
  }

  // One-time migration: move legacy localStorage blobs into IndexedDB and free the space.
  function migrateLegacyFiles() {
    if (!window.indexedDB) return Promise.resolve();
    var jobs = readIndex().map(function (f) {
      var legacy = null;
      try { legacy = localStorage.getItem(LS_FILE + f.id); } catch (e) { /* ignore */ }
      if (legacy == null) return Promise.resolve();
      return idbPut(f.id, legacy).then(function () {
        try { localStorage.removeItem(LS_FILE + f.id); } catch (e) { /* ignore */ }
      }, function () { /* ignore */ });
    });
    return Promise.all(jobs).catch(function () {});
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
    buildQueryDatabase();
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

    var lastId = null;
    var lastSQL = null;

    // Process files one at a time to keep memory bounded for large dumps.
    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        return readFileAsText(file).then(function (sql) {
          lastSQL = sql;
          return cacheFile(file.name, sql).then(function (id) {
            if (id) lastId = id;
          });
        });
      });
    });

    chain.then(function () {
      refreshFilePicker();
      if (lastId) {
        setActiveId(lastId);
        fileSelect.value = lastId;
        return readFileSQL(lastId).then(function (sql) {
          loadSQL(sql != null ? sql : lastSQL);
        });
      }
      if (lastSQL != null) loadSQL(lastSQL); // couldn't persist — view in memory
    }).catch(function (err) {
      console.error(err);
      alert('Could not import the file: ' + (err && err.message ? err.message : err));
    });

    fileInput.value = ''; // allow re-importing the same file name
  });

  // ---- Switch between cached files ----
  fileSelect.addEventListener('change', function () {
    var id = fileSelect.value;
    setActiveId(id);
    readFileSQL(id).then(function (sql) {
      if (sql != null) loadSQL(sql);
    });
  });

  // ---- Remove the selected cached file ----
  btnRemoveFile.addEventListener('click', function () {
    var id = fileSelect.value;
    if (!id) return;
    var idx = readIndex();
    var f = null;
    for (var i = 0; i < idx.length; i++) { if (idx[i].id === id) { f = idx[i]; break; } }
    if (f && !confirm('Remove "' + f.name + '" from cache?')) return;

    removeCachedFile(id).then(function (remaining) {
      if (remaining.length) {
        var nextId = remaining[0].id;
        setActiveId(nextId);
        refreshFilePicker();
        fileSelect.value = nextId;
        return readFileSQL(nextId).then(function (sql) {
          if (sql != null) loadSQL(sql);
        });
      }
      setActiveId(null);
      refreshFilePicker();
      allTables = [];
      buildSidebar();
      showEmpty();
    });
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
    lastTableName = name;
    queryResultActive = false;

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
    rowCountEl.textContent = formatCount(activeTable.rows.length, 'row');
    colCountEl.textContent = formatCount(activeTable.columns.length, 'column');
    updateQueryPlaceholder(activeTable);

    buildGrid();
  }

  function showEmpty() {
    activeTable = null;
    lastTableName = null;
    queryResultActive = false;
    queryDatabase = null;
    emptyState.classList.remove('hidden');
    tableView.classList.add('hidden');
    btnExportCSV.disabled = true;
    btnRunQuery.disabled = true;
    setQueryStatus('', '');
  }

  // ---- SQL query console ----
  function quoteSQLIdentifier(name) {
    return '[' + String(name).replace(/]/g, ']]') + ']';
  }

  function updateQueryPlaceholder(table) {
    if (!table) return;
    var idColumn = null;
    for (var i = 0; i < table.columns.length; i++) {
      if (table.columns[i].name.toLowerCase() === 'id') {
        idColumn = table.columns[i].name;
        break;
      }
    }
    sqlQuery.placeholder = idColumn
      ? 'SELECT * FROM ' + quoteSQLIdentifier(table.name) + ' WHERE ' + quoteSQLIdentifier(idColumn) + ' = 20;'
      : 'SELECT * FROM ' + quoteSQLIdentifier(table.name) + ' LIMIT 100;';
  }

  function setQueryStatus(message, state) {
    queryStatus.textContent = message || '';
    queryStatus.className = state || '';
    queryStatus.title = message || '';
  }

  function coerceQueryValue(value, columnType) {
    if (value === null || value === undefined) return null;
    var type = String(columnType || '').toLowerCase();
    var numberValue;

    if (/^(tinyint|smallint|mediumint|int|integer|bigint|year)\b/.test(type)) {
      numberValue = Number(value);
      if (!isFinite(numberValue)) return value;
      if (/^bigint\b/.test(type) && !Number.isSafeInteger(numberValue)) return value;
      return numberValue;
    }

    if (/^(decimal|numeric|float|double|real)\b/.test(type)) {
      numberValue = Number(value);
      return isFinite(numberValue) ? numberValue : value;
    }

    if (/^(bool|boolean)\b/.test(type)) {
      if (value === true || value === false) return value;
      if (String(value) === '1' || String(value).toLowerCase() === 'true') return true;
      if (String(value) === '0' || String(value).toLowerCase() === 'false') return false;
    }

    return value;
  }

  function buildQueryDatabase() {
    queryDatabase = null;
    btnRunQuery.disabled = true;

    if (typeof window.alasql !== 'function' || !window.alasql.Database) {
      setQueryStatus('SQL engine could not be loaded. Check your internet connection.', 'error');
      return;
    }

    try {
      var db = new window.alasql.Database();
      allTables.forEach(function (table) {
        db.exec('CREATE TABLE ' + quoteSQLIdentifier(table.name));

        var records = table.rows.map(function (row) {
          var record = {};
          table.columns.forEach(function (column, columnIndex) {
            var value = columnIndex < row.length ? row[columnIndex] : null;
            record[column.name] = coerceQueryValue(value, column.type);
          });
          return record;
        });

        db.tables[table.name].data = records;
      });

      queryDatabase = db;
      btnRunQuery.disabled = allTables.length === 0;
      setQueryStatus(formatCount(allTables.length, 'table') + ' ready', '');
    } catch (err) {
      console.error('Could not build query database', err);
      setQueryStatus('Could not prepare SQL tables: ' + getErrorMessage(err), 'error');
    }
  }

  // Replace comments, string literals, and quoted identifiers with spaces so
  // statement separators and mutating SQL keywords can be checked safely.
  function maskSQLQuotedContent(sql) {
    var output = '';
    var i = 0;

    while (i < sql.length) {
      var char = sql[i];
      var next = sql[i + 1];

      if ((char === '-' && next === '-') || char === '#') {
        while (i < sql.length && sql[i] !== '\n') {
          output += ' ';
          i++;
        }
        continue;
      }

      if (char === '/' && next === '*') {
        output += '  ';
        i += 2;
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
          output += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
        if (i < sql.length) {
          output += '  ';
          i += 2;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === '`' || char === '[') {
        var closing = char === '[' ? ']' : char;
        output += ' ';
        i++;
        while (i < sql.length) {
          if (sql[i] === '\\' && char !== '[') {
            output += ' ';
            i++;
            if (i < sql.length) { output += ' '; i++; }
            continue;
          }
          if (sql[i] === closing) {
            output += ' ';
            if (sql[i + 1] === closing) {
              output += ' ';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          output += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }

      output += char;
      i++;
    }

    return output;
  }

  function validateReadOnlyQuery(sql) {
    var masked = maskSQLQuotedContent(sql).trim();
    if (!masked) throw new Error('Enter a SQL query first.');

    // A trailing semicolon is fine; multiple statements are not.
    var withoutTrailingSemicolons = masked.replace(/;+\s*$/, '');
    if (withoutTrailingSemicolons.indexOf(';') >= 0) {
      throw new Error('Run one SELECT statement at a time.');
    }

    if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemicolons)) {
      throw new Error('The data viewer accepts read-only SELECT queries.');
    }

    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|INTO|ATTACH|DETACH)\b/i.test(withoutTrailingSemicolons)) {
      throw new Error('Only read-only SELECT queries are allowed.');
    }
  }

  function normalizeQueryResult(result) {
    var columnNames = [];
    var rows = [];

    if (!Array.isArray(result)) result = [result];
    if (result.length === 0) return { columns: [], rows: [] };

    var hasObjects = result.some(function (item) {
      return item !== null && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Date);
    });

    if (hasObjects) {
      result.forEach(function (item) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return;
        Object.keys(item).forEach(function (key) {
          if (columnNames.indexOf(key) < 0) columnNames.push(key);
        });
      });
      rows = result.map(function (item) {
        return columnNames.map(function (name) {
          return item && Object.prototype.hasOwnProperty.call(item, name) ? item[name] : null;
        });
      });
    } else if (result.some(Array.isArray)) {
      var widestRow = 0;
      result.forEach(function (item) {
        if (Array.isArray(item)) widestRow = Math.max(widestRow, item.length);
      });
      for (var i = 0; i < widestRow; i++) columnNames.push('column_' + (i + 1));
      rows = result.map(function (item) {
        return Array.isArray(item) ? item : [item];
      });
    } else {
      columnNames = ['value'];
      rows = result.map(function (item) { return [item]; });
    }

    var columns = columnNames.map(function (name, columnIndex) {
      var type = '';
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        var value = rows[rowIndex][columnIndex];
        if (value === null || value === undefined) continue;
        if (value instanceof Date) type = 'datetime';
        else if (Array.isArray(value)) type = 'array';
        else type = typeof value;
        break;
      }
      return { name: name, type: type };
    });

    return { columns: columns, rows: rows };
  }

  function showQueryResult(result, elapsedMs) {
    var normalized = normalizeQueryResult(result);
    activeTable = {
      name: 'Query result',
      exportName: 'query-result',
      columns: normalized.columns,
      foreignKeys: [],
      rows: normalized.rows
    };
    queryResultActive = true;

    var items = sidebarNav.querySelectorAll('li');
    items.forEach(function (li) { li.classList.remove('active'); });

    sortCol = -1;
    sortAsc = true;
    currentPage = 0;
    dataSearch.value = '';
    tableNameEl.textContent = activeTable.name;
    rowCountEl.textContent = formatCount(activeTable.rows.length, 'row');
    colCountEl.textContent = formatCount(activeTable.columns.length, 'column');
    btnExportCSV.disabled = false;

    buildGrid();
    setQueryStatus(
      formatCount(activeTable.rows.length, 'row') + ' · ' + formatDuration(elapsedMs),
      'success'
    );
  }

  function formatDuration(milliseconds) {
    return (milliseconds < 1 ? milliseconds.toFixed(2) : milliseconds.toFixed(1)) + ' ms';
  }

  function getErrorMessage(err) {
    if (!err) return 'Unknown error';
    return err.message || String(err);
  }

  function runSQLQuery() {
    var query = sqlQuery.value.trim();

    try {
      validateReadOnlyQuery(query);
    } catch (err) {
      setQueryStatus(getErrorMessage(err), 'error');
      return;
    }

    if (!queryDatabase) {
      setQueryStatus('SQL engine is not ready.', 'error');
      return;
    }

    var databaseAtStart = queryDatabase;
    btnRunQuery.disabled = true;
    setQueryStatus('Running…', '');

    // Let the browser paint the running state before AlaSQL executes synchronously.
    setTimeout(function () {
      if (databaseAtStart !== queryDatabase) return;
      var startedAt = window.performance && performance.now ? performance.now() : Date.now();
      try {
        var result = databaseAtStart.exec(query);
        var finishedAt = window.performance && performance.now ? performance.now() : Date.now();
        showQueryResult(result, finishedAt - startedAt);
      } catch (err) {
        console.error('SQL query failed', err);
        setQueryStatus(getErrorMessage(err), 'error');
      } finally {
        btnRunQuery.disabled = !queryDatabase;
      }
    }, 0);
  }

  btnRunQuery.addEventListener('click', runSQLQuery);
  sqlQuery.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      runSQLQuery();
    }
  });
  btnClearQuery.addEventListener('click', function () {
    sqlQuery.value = '';
    if (queryResultActive && lastTableName) {
      selectTable(lastTableName);
    }
    setQueryStatus(allTables.length ? formatCount(allTables.length, 'table') + ' ready' : '', '');
    sqlQuery.focus();
  });

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

    if (pageRows.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = activeTable.columns.length + 1;
      emptyCell.className = 'empty-grid';
      emptyCell.textContent = queryResultActive ? 'The query returned no rows.' : 'No rows to display.';
      emptyRow.appendChild(emptyCell);
      gridBody.appendChild(emptyRow);
    }

    // Pagination controls
    btnPrev.disabled = currentPage <= 0;
    btnNext.disabled = currentPage >= totalPages - 1;
    pageInfo.textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages;

    // Footer
    if (filteredRows.length === 0) {
      showingInfo.textContent = 'Showing 0 rows';
    } else if (filteredRows.length === activeTable.rows.length) {
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
    a.download = (activeTable.exportName || activeTable.name) + '.csv';
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
    migrateLegacyFiles().then(function () {
      refreshFilePicker();
      var idx = readIndex();
      if (!idx.length) { showEmpty(); return; }

      var active = getActiveId();
      var found = false;
      for (var i = 0; i < idx.length; i++) {
        if (idx[i].id === active) { found = true; break; }
      }
      if (!found) { active = idx[0].id; setActiveId(active); }

      fileSelect.value = active;
      readFileSQL(active).then(function (sql) {
        if (sql != null) loadSQL(sql);
        else showEmpty();
      });
    });
  })();
})();
