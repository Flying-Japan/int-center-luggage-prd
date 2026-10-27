import assert from 'node:assert/strict';
function sqlTokens(sql) {
  const lexer = /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|[xX]'(?:[^']|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*|->>|->|\|\||!=|<>|<=|>=|==|<<|>>|[^\s]/gy;
  const tokens = [];
  let match;
  while ((match = lexer.exec(sql)) !== null) {
    const text = match[0];
    if (/^\s|^--|^\/\*/.test(text)) continue;
    if (/^['"`\[]$/.test(text) || (text === '/' && sql[lexer.lastIndex] === '*')) {
      throw new Error(`Unterminated SQL quote/comment at character ${match.index + 1}`);
    }
    tokens.push({ text, start: match.index, end: lexer.lastIndex,
      word: /^[A-Za-z_][A-Za-z0-9_$]*$/.test(text) ? text.toUpperCase() : null });
  }
  return tokens;
}

function splitSql(sql) {
  const statements = [];
  const blocks = [];
  let start = null;
  let header = [];
  let trigger = false;
  for (const token of sqlTokens(sql)) {
    if (start === null) start = token.start;
    if (header.length < 3) header.push(token.word);
    trigger = header[0] === 'CREATE' && (header[1] === 'TRIGGER'
      || (['TEMP', 'TEMPORARY'].includes(header[1]) && header[2] === 'TRIGGER'));
    if (token.word === 'CASE' || (trigger && token.word === 'BEGIN')) blocks.push(token.word);
    if (token.word === 'END' && !blocks.pop()) throw new Error(`Unmatched SQL END at character ${token.start + 1}`);
    if (token.text === ';' && blocks.length === 0) {
      const query = sql.slice(start, token.end).trim();
      if (query !== ';') statements.push(query);
      start = null;
      header = [];
      trigger = false;
    }
  }
  if (blocks.length) throw new Error(`Unclosed SQL ${blocks.at(-1)} block`);
  if (start !== null) statements.push(sql.slice(start).trim());
  return statements;
}

function canonicalSqlTokens(sql) {
  const tokens = sqlTokens(sql);
  // SQLite omits this CREATE-header clause in sqlite_master. Never strip it from
  // a literal or body, and never collapse whitespace/escapes inside quoted tokens.
  const kindIndex = tokens[1]?.word === 'UNIQUE' ? 2 : 1;
  const clause = kindIndex + 1;
  if (tokens[0]?.word === 'CREATE' && ['INDEX', 'VIEW', 'TRIGGER'].includes(tokens[kindIndex]?.word)
    && tokens[clause]?.word === 'IF' && tokens[clause + 1]?.word === 'NOT' && tokens[clause + 2]?.word === 'EXISTS') {
    tokens.splice(clause, 3);
  }
  if (tokens.at(-1)?.text === ';') tokens.pop();
  return tokens;
}

function assertSameSql(name, actual, expected, actualLabel = 'sqlite_master', expectedLabel = 'src/schema.sql') {
  const left = canonicalSqlTokens(actual);
  const right = canonicalSqlTokens(expected);
  let index = 0;
  while (index < left.length && index < right.length && left[index].text === right[index].text) index++;
  if (index === left.length && index === right.length) return;
  const a = left[index]?.text ?? '';
  const b = right[index]?.text ?? '';
  let within = 0;
  while (within < a.length && within < b.length && a[within] === b[within]) within++;
  const context = tokens => {
    const start = Math.max(0, index - 3);
    return JSON.stringify(tokens.slice(start, index + 4).map((token, offset) => {
      const from = start + offset === index ? Math.max(0, within - 20) : 0;
      const text = token.text.slice(from, from + 44);
      return `${from ? '...' : ''}${text}${from + 44 < token.text.length ? '...' : ''}`;
    }).join(' '));
  };
  // Do not assert.equal on SQL strings: Node expands the entire colored SQL diff.
  throw new Error(`SQL definition mismatch: ${name}; first difference at token ${index + 1}; `
    + `${actualLabel} character ${(left[index]?.start ?? actual.length) + (left[index] ? within : 0) + 1}: ${context(left)}; `
    + `${expectedLabel} character ${(right[index]?.start ?? expected.length) + (right[index] ? within : 0) + 1}: ${context(right)}`);
}

function checkSqlComparisonContract() {
  // Runs only on the user's explicit invocation, before creating or opening D1.
  const view = "CREATE VIEW IF NOT EXISTS v AS SELECT CASE WHEN 1 THEN 'END; -- /*' ELSE '' END, ABS(CASE WHEN 2 THEN 3 ELSE 4 END);";
  const trigger = "CREATE TRIGGER t AFTER UPDATE ON x BEGIN SELECT CASE WHEN 1 THEN 'a'';b' ELSE 'z' END; SELECT 2; END;";
  const queries = splitSql(`${view}\n/* END; */ ${trigger}\nCREATE INDEX i ON x(a);`);
  assert.equal(queries.length, 3, 'CASE END, and END) must not merge adjacent definitions');
  assertSameSql('split CASE view', queries[0], view);
  assertSameSql('split trigger body', queries[1], trigger);
  assertSameSql('header/format only', "CREATE VIEW v AS SELECT 'IF NOT EXISTS  x';",
    "CREATE VIEW IF NOT EXISTS v\nAS /* spacing */ SELECT 'IF NOT EXISTS  x'");
  for (const [before, after] of [
    ["SELECT 'a  b'", "SELECT 'a b'"], ["SELECT 'IF NOT EXISTS x'", "SELECT 'x'"],
    ["SELECT 'a''b'", "SELECT 'ab'"], ['SELECT 1 WHERE a >= 0', 'SELECT 1 WHERE a > 0'],
    ['SELECT a, b', 'SELECT b, a'], [trigger, trigger.replace('SELECT 2', 'SELECT 3')],
  ]) {
    assert.notDeepEqual(canonicalSqlTokens(before).map(t => t.text), canonicalSqlTokens(after).map(t => t.text),
      'SQL comparison must retain literal, condition, column and trigger-body differences');
  }
}


export { sqlTokens, splitSql, assertSameSql, checkSqlComparisonContract };
