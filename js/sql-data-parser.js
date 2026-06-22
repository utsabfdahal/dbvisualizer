/**
 * SQL dump parser — extracts table structures and row data from MySQL/MariaDB dumps.
 * Handles CREATE TABLE + INSERT INTO statements.
 *
 * Exposes: window.DBV.parseSQLDump(source) -> { tables: { name, columns[], rows[][] }, errors[] }
 */
(function () {
  'use strict';

  /**
   * Parse a MySQL / MariaDB .sql dump and return table metadata + data rows.
   */
  function parseSQLDump(source) {
    var tables = {};
    var errors = [];
    var lines = source.split('\n');

    var i = 0;

    while (i < lines.length) {
      var line = lines[i].trim();

      // ---- CREATE TABLE ----
      if (/^CREATE\s+TABLE/i.test(line)) {
        var result = parseCreateTable(lines, i, errors);
        if (result) {
          tables[result.name] = {
            name: result.name,
            columns: result.columns,
            foreignKeys: result.foreignKeys || [],
            rows: []
          };
          i = result.endLine + 1;
          continue;
        }
      }

      // ---- INSERT INTO ----
      if (/^INSERT\s+INTO/i.test(line)) {
        var insResult = parseInsert(lines, i, tables, errors);
        if (insResult) {
          i = insResult.endLine + 1;
          continue;
        }
      }

      i++;
    }

    // Convert tables map to array
    var tableList = [];
    for (var name in tables) {
      if (tables.hasOwnProperty(name)) {
        tableList.push(tables[name]);
      }
    }

    return { tables: tableList, errors: errors };
  }

  /**
   * Parse a CREATE TABLE block starting at line index `start`.
   */
  function parseCreateTable(lines, start, errors) {
    // Collect the full CREATE TABLE statement
    var buf = '';
    var end = start;
    for (var i = start; i < lines.length; i++) {
      buf += lines[i] + '\n';
      end = i;
      if (/;[\s]*$/.test(lines[i].trim())) break;
    }

    // Extract table name
    var nameMatch = buf.match(/CREATE\s+TABLE\s+`?(\w+)`?/i);
    if (!nameMatch) {
      errors.push({ line: start + 1, message: 'Could not parse table name from CREATE TABLE' });
      return null;
    }

    var tableName = nameMatch[1];
    var columns = [];

    // Extract column definitions (lines between parentheses)
    var bodyMatch = buf.match(/\(([\s\S]+)\)\s*(ENGINE|;)/i);
    if (!bodyMatch) {
      // Fallback: try simpler match
      bodyMatch = buf.match(/\(([\s\S]+)\)/);
    }
    if (!bodyMatch) {
      errors.push({ line: start + 1, message: 'Could not parse body of CREATE TABLE ' + tableName });
      return { name: tableName, columns: [], endLine: end };
    }

    var body = bodyMatch[1];
    var colLines = splitColumnDefs(body);
    var foreignKeys = []; // { column, refTable, refColumn }

    for (var j = 0; j < colLines.length; j++) {
      var cl = colLines[j].trim();
      if (!cl) continue;

      // Extract FOREIGN KEY constraints
      var fkMatch = cl.match(/FOREIGN\s+KEY\s*\(`?(\w+)`?\)\s*REFERENCES\s+`?(\w+)`?\s*\(`?(\w+)`?\)/i);
      if (fkMatch) {
        foreignKeys.push({ column: fkMatch[1], refTable: fkMatch[2], refColumn: fkMatch[3] });
        continue;
      }

      // Skip other constraints, keys, indexes
      if (/^(PRIMARY\s+KEY|UNIQUE\s+KEY|KEY\s+|INDEX\s+|CONSTRAINT\s+|CHECK\s+|FOREIGN\s+KEY)/i.test(cl)) continue;

      var colMatch = cl.match(/^`?(\w+)`?\s+(.+)/);
      if (colMatch) {
        var colName = colMatch[1];
        var rest = colMatch[2];
        // Extract type (first token, may include parenthesized args)
        var typeMatch = rest.match(/^(\w+(?:\s*\([^)]*\))?)/);
        var colType = typeMatch ? typeMatch[1] : rest.split(/\s/)[0];
        columns.push({ name: colName, type: colType });
      }
    }

    return { name: tableName, columns: columns, foreignKeys: foreignKeys, endLine: end };
  }

  /**
   * Split column definition body on top-level commas.
   */
  function splitColumnDefs(body) {
    var parts = [];
    var depth = 0;
    var cur = '';
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  /**
   * Parse INSERT INTO ... VALUES (...),(...); statement spanning possibly
   * multiple lines.
   */
  function parseInsert(lines, start, tables, errors) {
    // Collect entire INSERT statement (may span multiple lines)
    var buf = '';
    var end = start;
    for (var i = start; i < lines.length; i++) {
      buf += lines[i] + '\n';
      end = i;
      if (/;\s*$/.test(lines[i].trim())) break;
    }

    // Extract table name
    var nameMatch = buf.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    if (!nameMatch) {
      errors.push({ line: start + 1, message: 'Could not parse INSERT INTO table name' });
      return { endLine: end };
    }

    var tableName = nameMatch[1];
    var table = tables[tableName];
    if (!table) {
      // Table not defined via CREATE TABLE — create a placeholder
      table = { name: tableName, columns: [], rows: [] };
      tables[tableName] = table;
    }

    // Extract everything after VALUES keyword
    var valuesIdx = buf.search(/VALUES\s*/i);
    if (valuesIdx < 0) {
      errors.push({ line: start + 1, message: 'INSERT missing VALUES keyword for ' + tableName });
      return { endLine: end };
    }

    var afterValues = buf.slice(valuesIdx).replace(/^VALUES\s*/i, '');

    // Parse row tuples
    var rows = parseValueTuples(afterValues);
    for (var r = 0; r < rows.length; r++) {
      table.rows.push(rows[r]);
    }

    return { endLine: end };
  }

  /**
   * Parse "(v1,v2,...),(v1,v2,...),..." into arrays of string values.
   */
  function parseValueTuples(str) {
    var rows = [];
    var i = 0;

    while (i < str.length) {
      // Find opening paren
      while (i < str.length && str[i] !== '(') i++;
      if (i >= str.length) break;
      i++; // skip '('

      var vals = [];
      var val = '';
      var inQuote = false;
      var quoteChar = '';
      var escaped = false;

      while (i < str.length) {
        var c = str[i];

        if (escaped) {
          // Handle common escape sequences for display
          if (c === 'n') val += '\n';
          else if (c === 't') val += '\t';
          else if (c === '0') val += '';
          else val += c;
          escaped = false;
          i++;
          continue;
        }

        if (c === '\\' && inQuote) {
          escaped = true;
          i++;
          continue;
        }

        if (inQuote) {
          if (c === quoteChar) {
            // Check for double-quote escape ('')
            if (i + 1 < str.length && str[i + 1] === quoteChar) {
              val += c;
              i += 2;
              continue;
            }
            inQuote = false;
            i++;
            continue;
          }
          val += c;
          i++;
          continue;
        }

        if (c === "'" || c === '"') {
          inQuote = true;
          quoteChar = c;
          i++;
          continue;
        }

        if (c === ',' ) {
          vals.push(val.trim());
          val = '';
          i++;
          continue;
        }

        if (c === ')') {
          vals.push(val.trim());
          rows.push(vals);
          i++;
          break;
        }

        val += c;
        i++;
      }
    }

    // Clean up NULL values
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        if (rows[r][c].toUpperCase() === 'NULL') {
          rows[r][c] = null;
        }
      }
    }

    return rows;
  }

  // Expose
  window.DBV = window.DBV || {};
  window.DBV.parseSQLDump = parseSQLDump;
})();
