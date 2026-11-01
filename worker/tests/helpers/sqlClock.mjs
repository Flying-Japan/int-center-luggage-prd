// Test-only D1 adapter: substitute clock expressions, not guards or policy data.
export function rewriteSqlClock(sql, milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) throw Error('INVALID_TEST_CLOCK');
  const iso = new Date(milliseconds).toISOString();
  const constants = {CURRENT_TIMESTAMP:iso.slice(0,19).replace('T',' '),CURRENT_DATE:iso.slice(0,10),CURRENT_TIME:iso.slice(11,19)};
  const frames = []; let previous = '';
  return sql.replace(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\b[A-Za-z_][A-Za-z_0-9]*\b|[(),]|\s+|./g, token => {
    if (/^\s+$|^--|^\/\*/.test(token)) return token;
    const frame = frames.at(-1); let replacement = token;
    if (token === '(') frames.push({name:previous.toLowerCase(),argument:0});
    else if (token === ')') frames.pop();
    else if (token === ',' && frame) frame.argument++;
    else if (token.startsWith("'")) {
      if (token.slice(1,-1).replaceAll("''", "'").toLowerCase() === 'now' && frame
          && ((['date','time','datetime','julianday','unixepoch'].includes(frame.name) && frame.argument === 0)
            || (frame.name === 'strftime' && frame.argument === 1))) replacement = `'${iso}'`;
    } else if (previous !== '.' && Object.hasOwn(constants,token.toUpperCase())) replacement = `'${constants[token.toUpperCase()]}'`;
    previous = token; return replacement;
  });
}

export function withSqlClock(database, milliseconds) {
  return new Proxy(database, {get(target,key){
    if (key === 'prepare') return sql => target.prepare(rewriteSqlClock(sql,milliseconds));
    if (key === 'exec') return sql => target.exec(rewriteSqlClock(sql,milliseconds));
    const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
  }});
}
