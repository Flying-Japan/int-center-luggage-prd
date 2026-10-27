// Fixed artifact, never an env/header/session switch. Only these signed reads run.
export const F0_READ_PATHS = new Set([
  '/internal/luggage-orders', '/internal/luggage-orders/dashboard-sync',
  '/internal/luggage-sales-analytics', '/internal/luggage-sales-heatmap',
  '/internal/luggage-cash-closings',
]);
/** Capability guard: no batch/exec/run/session and no DML hidden in WITH/RETURNING. */
export function readOnlyDatabase(db: D1Database): D1Database {
  const forbidden = () => { throw new Error('F0_READ_ONLY'); };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (key === 'first' || key === 'all' || key === 'raw') return target[key].bind(target);
      return forbidden;
    },
  });
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return forbidden;
      return (sql: string) => {
        // Strip quoted tokens/comments only for validation; execute the original SQL.
        const tokens = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ')
          .trim().replace(/;\s*$/, '');
        if (!/^(?:SELECT|WITH)\b/i.test(tokens) || /;|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK)\b/i.test(tokens)) forbidden();
        return wrap(target.prepare(sql));
      };
    },
  });
}

