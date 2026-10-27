import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const TEST_SECRET = 'm0-local-test-only-not-a-production-secret';
export const HOSTS = ['https://luggage.flyingjp.com', 'https://m0-local-only.workers.dev'];

/** Inventory the legacy route registrations, including GET callbacks, without running their handlers. */
export function discoverRoutes(workerDir) {
  const ts = createRequire(join(workerDir, 'package.json'))('typescript');
  const files = ['src/index.tsx', ...readdirSync(join(workerDir, 'src/routes')).filter(f => /\.tsx?$/.test(f)).map(f => 'src/routes/' + f)];
  const routes = new Map();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(join(workerDir, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].includes(node.expression.name.text)
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('/')) {
        const method = node.expression.name.text.toUpperCase(), path = node.arguments[0].text;
        const key = `${method} ${path}`;
        if (!routes.has(key)) routes.set(key, { method, path, sources: [] });
        routes.get(key).sources.push(file);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...routes.values()].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

export function concretePath(template) {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)(?:\{[^}]*\})?/g, (_, name) => name === 'kind' ? 'id' : '20261027-001').replace(/\*/g, 'm0-test');
}

export async function assertResponse(response, { health = false, html = false, head = false } = {}) {
  assert.equal(response.status, health ? 200 : 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('Retry-After'), null, 'financial requests must not invite automatic retries');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('X-Maintenance-Code'), 'MAINTENANCE');
  if (head) { assert.equal(await response.text(), ''); return; }
  if (html) {
    assert.match(response.headers.get('Content-Type') || '', /^text\/html/);
    const text = await response.text();
    assert.match(text, /서비스 점검 중/);
    assert.doesNotMatch(text, /<script|<form|<img|<iframe|http-equiv|<meta[^>]+refresh/i);
    return;
  }
  assert.match(response.headers.get('Content-Type') || '', /^application\/json/);
  const data = await response.json();
  if (health) assert.deepEqual(data, { status: 'maintenance', service: 'luggage-storage', mode: 'M0' });
  else {
    assert.equal(data.code, 'MAINTENANCE');
    assert.equal(data.mode, 'M0');
    assert.equal(data.retryable, false);
    assert.equal(typeof data.error, 'string');
    assert.equal(data.orderId, undefined);
    assert.equal(data.request_id, undefined);
  }
}
