// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answers as the reference on every input ({columns, rows, errors} for
// {text, header}), reached a different way: the reference walks the text one
// character at a time and grows each field with `value += c`; this reader
// jumps from delimiter to delimiter with indexOf and cuts each plain field
// out with a single slice, so the common case (a short unquoted field with
// no stray CR) costs two indexOf scans and one slice and no per-character
// work at all. Quoted fields take the same shortcut when they hold no
// doubled quote and no line break inside; only the rare broken shapes
// (doubled quotes, embedded line breaks, stray CRs, unterminated quotes)
// fall back to a small segment loop. No caching between calls, no state
// kept from one case to the next: run(input) is pure.
//
// Broken-row policy, matching csv-reader 1.0.0 exactly:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote, each CRLF or lone CR inside it is
//     read as LF); what follows its closing quote up to the next comma or
//     line break is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     the records after it, each padded with "" (short_row) or cut
//     (long_row) to the first record's width;
//   - each error is {code, line, row} in the order met; line is the 1-based
//     line its record starts on, row its index in rows (null for the header).

// How a field ended: at a comma, at a line break, or at the end of the text.
const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while the header is still unread). error() reads these live.
  let recordLine = 1;
  let recordRow = null;

  // The value of the field just read; the readers below set it and return
  // how the field ended, so no per-field object is ever allocated.
  let fVal = '';

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, with `init` already in it
  // ("" for a fresh field, the quoted value for junk after a closing
  // quote). Returns COMMA, BREAK or END and sets fVal.
  function readUnquoted(init) {
    let val = init;
    const cPos = text.indexOf(',', pos);
    const nPos = text.indexOf('\n', pos);
    let m;
    let kind;
    if (cPos === -1) {
      if (nPos === -1) { m = len; kind = END; }
      else { m = nPos; kind = BREAK; }
    } else if (nPos === -1 || cPos < nPos) {
      m = cPos; kind = COMMA;
    } else {
      m = nPos; kind = BREAK;
    }
    let seg = text.slice(pos, m);
    // A CR right before the LF is the CRLF line break, not a stray CR.
    if (kind === BREAK && seg.charCodeAt(seg.length - 1) === 13) {
      seg = seg.slice(0, -1);
    }
    if (seg.indexOf('\r') === -1) {
      // The fast lane: no stray CR anywhere in the field.
      if (val !== '') val += seg;
      else val = seg;
    } else {
      // Rare lane: drop each lone CR, one stray_cr error apiece.
      let out = '';
      let s = 0;
      for (let i = 0; i < seg.length; i++) {
        if (seg.charCodeAt(i) === 13) {
          out += seg.slice(s, i);
          s = i + 1;
          error('stray_cr');
        }
      }
      out += seg.slice(s);
      if (val !== '') val += out;
      else val = out;
    }
    if (kind === COMMA) pos = m + 1;
    else if (kind === BREAK) { pos = m + 1; line += 1; }
    else pos = len;
    fVal = val;
    return kind;
  }

  // What follows a closing quote at pos: a comma, a line break, the end,
  // or junk appended as it stands. Returns how the field ended, sets fVal.
  function afterQuote() {
    if (pos >= len) return END;
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return COMMA; }
    if (c === 10) { pos += 1; line += 1; return BREAK; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; return BREAK;
    }
    // Junk after the closing quote, read again as unquoted.
    const before = fVal;
    const ended = readUnquoted(before);
    if (fVal.length > before.length) error('quote_junk');
    return ended;
  }

  // Reads a quoted field whose opening quote is at pos. Returns how the
  // field ended and sets fVal.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const p = pos + 1;
    const q = text.indexOf('"', p);
    if (q === -1) {
      // No quote at all after the opening one: it never closes.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (text.charCodeAt(q + 1) !== 34) {
      // The first quote after the opening one closes the field, unless a
      // line break hides inside it (then the slow lane counts the lines).
      const nl = text.indexOf('\n', p);
      const cr = text.indexOf('\r', p);
      if ((nl === -1 || nl >= q) && (cr === -1 || cr >= q)) {
        fVal = text.slice(p, q);
        pos = q + 1;
        return afterQuote();
      }
    }
    // Slow lane: doubled quotes and/or line breaks inside the field.
    // Segments are collected only where something has to change ("" -> ",
    // CR / CRLF -> LF); plain stretches, LF included, stay in the slice.
    const parts = [];
    let segStart = p;
    let i = p;
    while (i < len) {
      const ch = text.charCodeAt(i);
      if (ch === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          parts.push(text.slice(segStart, i));
          parts.push('"');
          i += 2;
          segStart = i;
          continue;
        }
        parts.push(text.slice(segStart, i));
        fVal = parts.join('');
        pos = i + 1;
        return afterQuote();
      }
      if (ch === 13) {
        parts.push(text.slice(segStart, i));
        parts.push('\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        segStart = i;
        continue;
      }
      if (ch === 10) line += 1;
      i += 1;
    }
    // The quote never closes: it is a literal character, and the text
    // after it is read again as unquoted.
    pos = open + 1;
    line = openLine;
    error('unterminated_quote');
    return readUnquoted('"');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast lane for a whole record line: when the line holds no quote and
    // no stray CR (a trailing CR is just its CRLF ending), the record is
    // the line split on commas, cut out in C++ in one go. Anything else
    // falls through to the per-field readers below.
    let fields = null;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let lineText = text.slice(pos, lineEnd);
    if (nl !== -1 && lineText.charCodeAt(lineText.length - 1) === 13) {
      lineText = lineText.slice(0, -1);
    }
    if (lineText.indexOf('"') === -1 && lineText.indexOf('\r') === -1) {
      fields = lineText.split(',');
      if (nl === -1) pos = len;
      else { pos = nl + 1; line += 1; }
    }
    let quoted = false;
    if (fields === null) {
      fields = [];
      let ended;
      do {
        quoted = text.charCodeAt(pos) === 34;
        ended = quoted ? readQuoted() : readUnquoted('');
        fields.push(fVal);
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
