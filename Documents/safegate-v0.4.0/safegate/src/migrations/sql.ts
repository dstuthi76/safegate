export interface SqlStatement {
  /** Statement text with comments removed and whitespace collapsed */
  text: string;
  /** Original text, as written */
  raw: string;
  /** 1-based line where the statement starts */
  line: number;
}

/**
 * Splits a SQL script into statements. Understands -- and /* *\/ comments,
 * single-quoted strings, double-quoted identifiers and $tag$ dollar quoting,
 * so semicolons inside them do not split statements.
 */
export function splitSql(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let buf = "";
  let clean = "";
  let startLine = 1;
  let line = 1;
  let started = false;
  let i = 0;

  const push = () => {
    const text = clean.replace(/\s+/g, " ").trim();
    if (text) out.push({ text, raw: buf.trim(), line: startLine });
    buf = "";
    clean = "";
    started = false;
  };

  const mark = () => {
    if (!started) {
      started = true;
      startLine = line;
    }
  };

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "\n") line++;

    // line comment
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      if (started) buf += sql.slice(i, stop); // leading comments are not part of the statement
      i = stop;
      continue;
    }
    // block comment
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      const chunk = sql.slice(i, stop);
      line += (chunk.match(/\n/g) || []).length;
      if (started) buf += chunk;
      clean += " ";
      i = stop;
      continue;
    }
    // quoted string or identifier
    if (c === "'" || c === '"') {
      mark();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) {
          j += 2;
          continue;
        }
        if (sql[j] === c) break;
        j++;
      }
      const chunk = sql.slice(i, j + 1);
      line += (chunk.match(/\n/g) || []).length;
      buf += chunk;
      clean += chunk;
      i = j + 1;
      continue;
    }
    // dollar quoting
    if (c === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        mark();
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        const chunk = sql.slice(i, stop);
        line += (chunk.match(/\n/g) || []).length;
        buf += chunk;
        clean += chunk;
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    if (!/\s/.test(c)) mark();
    if (started) buf += c;
    clean += c;
    i++;
  }
  push();
  return out;
}

/** Strips surrounding double quotes and an optional schema prefix: "public"."Post" -> Post */
export function unquoteIdent(ident: string): string {
  const parts = ident.split(".");
  const last = parts[parts.length - 1].trim();
  return last.startsWith('"') && last.endsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last;
}

/** Matches a possibly-quoted, possibly schema-qualified identifier. */
export const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*))?`;
