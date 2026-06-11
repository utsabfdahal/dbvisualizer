/**
 * Minimal-but-practical DBML parser.
 * Supports: Table (schema, alias, settings, notes), columns with settings
 * (pk, not null, unique, increment, default, note, inline ref), Ref statements
 * (single-line, named, block form, composite columns), Enum, TableGroup, Project.
 *
 * Exposes window.DBV.parseDBML(source) -> { tables, refs, enums, groups, errors }
 */
(function () {
  'use strict';

  // ---------- helpers ----------

  function stripComments(src) {
    // block comments
    src = src.replace(/\/\*[\s\S]*?\*\//g, function (m) {
      return m.replace(/[^\n]/g, ' '); // keep line numbers
    });
    // line comments (outside quotes)
    return src
      .split('\n')
      .map(function (line) {
        var inQ = null;
        for (var i = 0; i < line.length; i++) {
          var c = line[i];
          if (inQ) {
            if (c === inQ && line[i - 1] !== '\\') inQ = null;
          } else if (c === "'" || c === '"' || c === '`') {
            inQ = c;
          } else if (c === '/' && line[i + 1] === '/') {
            return line.slice(0, i);
          }
        }
        return line;
      })
      .join('\n');
  }

  function unquote(s) {
    s = (s || '').trim();
    if (
      (s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'") ||
      (s[0] === '`' && s[s.length - 1] === '`')
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  // split on top-level commas (ignoring commas inside quotes/parens)
  function splitTopLevel(s, sep) {
    var parts = [];
    var depth = 0;
    var inQ = null;
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQ) {
        cur += c;
        if (c === inQ && s[i - 1] !== '\\') inQ = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        inQ = c;
        cur += c;
      } else if (c === '(' || c === '[') {
        depth++;
        cur += c;
      } else if (c === ')' || c === ']') {
        depth--;
        cur += c;
      } else if (c === sep && depth === 0) {
        parts.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim() !== '') parts.push(cur);
    return parts;
  }

  // split "schema.table.column" respecting quoted segments
  function splitPath(s) {
    return splitTopLevel(s, '.').map(unquote);
  }

  // ---------- endpoint parsing ----------

  // forms: table.col | schema.table.col | table.(c1, c2) | "My Table"."My Col"
  function parseEndpoint(str) {
    str = str.trim();
    var cols = null;
    var m = str.match(/\(([^)]*)\)\s*$/);
    if (m) {
      cols = m[1].split(',').map(function (c) { return unquote(c); });
      str = str.slice(0, m.index).replace(/\.\s*$/, '');
      var p = splitPath(str);
      return {
        schema: p.length > 1 ? p[p.length - 2] : null,
        table: p[p.length - 1],
        columns: cols
      };
    }
    var parts = splitPath(str);
    if (parts.length < 2) return null;
    return {
      schema: parts.length > 2 ? parts[parts.length - 3] : null,
      table: parts[parts.length - 2],
      columns: [parts[parts.length - 1]]
    };
  }

  function parseRefBody(body, name, errors, lineNo) {
    // body: "a.b > c.d [delete: cascade]"
    var settings = null;
    var sm = body.match(/\[([^\]]*)\]\s*$/);
    if (sm) {
      settings = sm[1];
      body = body.slice(0, sm.index);
    }
    var om = body.match(/(<>|[<>-])/);
    if (!om) {
      errors.push({ line: lineNo, message: 'Ref missing relation operator (<, >, -, <>): ' + body.trim() });
      return null;
    }
    var op = om[1];
    var left = body.slice(0, om.index).trim();
    var right = body.slice(om.index + op.length).trim();
    var from = parseEndpoint(left);
    var to = parseEndpoint(right);
    if (!from || !to) {
      errors.push({ line: lineNo, message: 'Could not parse ref endpoints: ' + body.trim() });
      return null;
    }
    return { name: name || null, from: from, to: to, op: op, settings: settings };
  }

  // ---------- column parsing ----------

  function parseColumnSettings(raw, col, refs, tableName, errors, lineNo) {
    splitTopLevel(raw, ',').forEach(function (part) {
      var s = part.trim();
      var sl = s.toLowerCase();
      if (sl === 'pk' || sl === 'primary key') col.pk = true;
      else if (sl === 'not null') col.notNull = true;
      else if (sl === 'null') col.notNull = false;
      else if (sl === 'unique') col.unique = true;
      else if (sl === 'increment') col.increment = true;
      else if (sl.indexOf('default:') === 0) col.default = unquote(s.slice(8).trim());
      else if (sl.indexOf('note:') === 0) col.note = unquote(s.slice(5).trim());
      else if (sl.indexOf('ref:') === 0) {
        var body = s.slice(4).trim();
        var m = body.match(/^(<>|[<>-])\s*(.+)$/);
        if (m) {
          var target = parseEndpoint(m[2]);
          if (target) {
            refs.push({
              name: null,
              from: { schema: null, table: tableName, columns: [col.name] },
              to: target,
              op: m[1],
              inline: true
            });
          } else {
            errors.push({ line: lineNo, message: 'Bad inline ref target: ' + m[2] });
          }
        } else {
          errors.push({ line: lineNo, message: 'Bad inline ref: ' + body });
        }
      }
      // unknown settings are silently ignored (e.g. custom)
    });
  }

  function parseColumn(line, refs, tableName, errors, lineNo) {
    var settingsRaw = null;
    var sm = line.match(/\[([^\]]*)\]\s*$/);
    if (sm) {
      settingsRaw = sm[1];
      line = line.slice(0, sm.index).trim();
    }
    var nm = line.match(/^("([^"]+)"|`([^`]+)`|[\w]+)\s+(.+)$/);
    if (!nm) return null;
    var col = {
      name: nm[2] || nm[3] || nm[1],
      type: unquote(nm[4].trim()),
      pk: false,
      notNull: false,
      unique: false,
      increment: false,
      default: null,
      note: null
    };
    if (settingsRaw !== null) {
      parseColumnSettings(settingsRaw, col, refs, tableName, errors, lineNo);
    }
    return col;
  }

  // ---------- main parser ----------

  function parseDBML(source) {
    var tables = [];
    var refs = [];
    var enums = [];
    var groups = [];
    var errors = [];

    var lines = stripComments(source).split('\n');

    var state = null; // null | 'table' | 'enum' | 'group' | 'skip' | 'refblock' | 'note'
    var cur = null;
    var skipDepth = 0;
    var noteBuf = null; // for triple-quoted notes
    var noteTargetSetter = null;

    var TABLE_RE = /^table\s+((?:"[^"]+"|[\w]+)(?:\s*\.\s*(?:"[^"]+"|[\w]+))?)\s*(?:as\s+("[^"]+"|[\w]+))?\s*(?:\[([^\]]*)\])?\s*\{?\s*$/i;
    var ENUM_RE = /^enum\s+((?:"[^"]+"|[\w]+)(?:\s*\.\s*(?:"[^"]+"|[\w]+))?)\s*(?:\{(.*))?$/i;
    var GROUP_RE = /^tablegroup\s+("[^"]+"|[\w]+)\s*(?:\[([^\]]*)\])?\s*\{?\s*$/i;
    var REF_LINE_RE = /^ref(?:\s+("[^"]+"|[\w]+))?\s*:\s*(.+)$/i;
    var REF_BLOCK_RE = /^ref(?:\s+("[^"]+"|[\w]+))?\s*\{\s*$/i;

    function parseTableSettings(raw) {
      var out = {};
      if (!raw) return out;
      splitTopLevel(raw, ',').forEach(function (p) {
        var kv = p.split(':');
        if (kv.length >= 2) {
          out[kv[0].trim().toLowerCase()] = unquote(kv.slice(1).join(':').trim());
        }
      });
      return out;
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      var lineNo = i + 1;
      if (line === '') continue;

      // --- multi-line ''' note collection ---
      if (state === 'note') {
        var endIdx = line.indexOf("'''");
        if (endIdx >= 0) {
          noteBuf.push(line.slice(0, endIdx));
          if (noteTargetSetter) noteTargetSetter(noteBuf.join('\n').trim());
          noteBuf = null;
          noteTargetSetter = null;
          state = cur ? 'table' : null;
        } else {
          noteBuf.push(line);
        }
        continue;
      }

      // --- skipping a block (Project / indexes / unsupported) ---
      if (state === 'skip') {
        skipDepth += (line.match(/\{/g) || []).length;
        skipDepth -= (line.match(/\}/g) || []).length;
        if (skipDepth <= 0) state = cur ? 'table' : null;
        continue;
      }

      // --- inside Ref block ---
      if (state === 'refblock') {
        if (line === '}') { state = null; continue; }
        var r = parseRefBody(line, cur && cur.refName, errors, lineNo);
        if (r) refs.push(r);
        continue;
      }

      // --- inside Enum ---
      if (state === 'enum') {
        if (line === '}') { state = null; cur = null; continue; }
        var vm = line.match(/^("([^"]+)"|[\w]+)/);
        if (vm) cur.values.push(vm[2] || vm[1]);
        continue;
      }

      // --- inside TableGroup ---
      if (state === 'group') {
        if (line === '}') { state = null; cur = null; continue; }
        if (/^note\s*:/i.test(line)) continue;
        splitPath(line).length && cur.tables.push(unquote(line));
        continue;
      }

      // --- inside Table ---
      if (state === 'table') {
        if (line === '}') {
          tables.push(cur);
          cur = null;
          state = null;
          continue;
        }
        if (/^indexes\s*\{?\s*$/i.test(line)) {
          state = 'skip';
          skipDepth = line.indexOf('{') >= 0 ? 1 : 0;
          if (skipDepth === 0) {
            // brace on next line
            while (i + 1 < lines.length && lines[i + 1].trim() === '') i++;
            if (i + 1 < lines.length && lines[i + 1].trim()[0] === '{') { i++; skipDepth = 1; }
          }
          continue;
        }
        var noteM = line.match(/^note\s*:\s*(.*)$/i);
        if (noteM) {
          var val = noteM[1].trim();
          if (val.indexOf("'''") === 0) {
            var rest = val.slice(3);
            var end = rest.indexOf("'''");
            if (end >= 0) {
              cur.note = rest.slice(0, end).trim();
            } else {
              noteBuf = [rest];
              noteTargetSetter = (function (t) { return function (v) { t.note = v; }; })(cur);
              state = 'note';
            }
          } else {
            cur.note = unquote(val);
          }
          continue;
        }
        var col = parseColumn(line, refs, cur.alias || cur.name, errors, lineNo);
        if (col) {
          cur.columns.push(col);
        } else {
          errors.push({ line: lineNo, message: 'Could not parse column: "' + line + '"' });
        }
        continue;
      }

      // --- top level ---
      var m;

      if (/^project\b/i.test(line)) {
        state = 'skip';
        cur = null;
        skipDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (skipDepth <= 0) skipDepth = 1; // assume block opens
        continue;
      }

      if ((m = line.match(TABLE_RE))) {
        var pathParts = splitTopLevel(m[1], '.').map(unquote);
        cur = {
          schema: pathParts.length > 1 ? pathParts[0].trim() : null,
          name: (pathParts.length > 1 ? pathParts[1] : pathParts[0]).trim(),
          alias: m[2] ? unquote(m[2]) : null,
          settings: parseTableSettings(m[3]),
          note: null,
          columns: []
        };
        state = 'table';
        if (line.indexOf('{') < 0) {
          // expect { on next non-empty line
          while (i + 1 < lines.length && lines[i + 1].trim() === '') i++;
          if (i + 1 < lines.length && lines[i + 1].trim()[0] === '{') i++;
        }
        continue;
      }

      if (/^enum\b/i.test(line) && (m = line.match(ENUM_RE))) {
        var ep = splitTopLevel(m[1], '.').map(unquote);
        cur = {
          schema: ep.length > 1 ? ep[0].trim() : null,
          name: (ep.length > 1 ? ep[1] : ep[0]).trim(),
          values: []
        };
        enums.push(cur);
        var inlineBody = m[2];
        if (inlineBody != null && inlineBody.indexOf('}') >= 0) {
          // single-line enum: Enum role { admin user guest }
          inlineBody.slice(0, inlineBody.indexOf('}')).split(/[\s,]+/).forEach(function (v) {
            v = unquote(v.trim());
            if (v) cur.values.push(v);
          });
          cur = null;
          state = null;
        } else {
          state = 'enum';
        }
        continue;
      }

      if ((m = line.match(GROUP_RE))) {
        cur = { name: unquote(m[1]), tables: [] };
        groups.push(cur);
        state = 'group';
        continue;
      }

      if ((m = line.match(REF_BLOCK_RE))) {
        cur = { refName: m[1] ? unquote(m[1]) : null };
        state = 'refblock';
        continue;
      }

      if ((m = line.match(REF_LINE_RE))) {
        var rr = parseRefBody(m[2], m[1] ? unquote(m[1]) : null, errors, lineNo);
        if (rr) refs.push(rr);
        continue;
      }

      if (line === '{' || line === '}') continue;

      errors.push({ line: lineNo, message: 'Unrecognized statement: "' + line.slice(0, 60) + '"' });
    }

    if (state === 'table' && cur) {
      tables.push(cur);
      errors.push({ line: lines.length, message: 'Unclosed table block: ' + cur.name });
    }

    // ---------- resolve aliases / build lookup ----------
    var byKey = {};
    tables.forEach(function (t) {
      t.key = t.name; // canonical key
      byKey[t.name.toLowerCase()] = t;
      if (t.schema) byKey[(t.schema + '.' + t.name).toLowerCase()] = t;
      if (t.alias) byKey[t.alias.toLowerCase()] = t;
    });

    function resolveEndpoint(ep) {
      var candidates = [];
      if (ep.schema) candidates.push(ep.schema + '.' + ep.table);
      candidates.push(ep.table);
      for (var j = 0; j < candidates.length; j++) {
        var t = byKey[candidates[j].toLowerCase()];
        if (t) return t.key;
      }
      return null;
    }

    var resolvedRefs = [];
    refs.forEach(function (r) {
      var fk = resolveEndpoint(r.from);
      var tk = resolveEndpoint(r.to);
      if (!fk || !tk) {
        errors.push({
          line: 0,
          message:
            'Ref references unknown table: ' +
            (fk ? '' : r.from.table) + (!fk && !tk ? ', ' : '') + (tk ? '' : r.to.table)
        });
        return;
      }
      resolvedRefs.push({
        name: r.name,
        op: r.op,
        from: { table: fk, column: r.from.columns[0], columns: r.from.columns },
        to: { table: tk, column: r.to.columns[0], columns: r.to.columns }
      });
    });

    return { tables: tables, refs: resolvedRefs, enums: enums, groups: groups, errors: errors };
  }

  window.DBV = window.DBV || {};
  window.DBV.parseDBML = parseDBML;
})();
