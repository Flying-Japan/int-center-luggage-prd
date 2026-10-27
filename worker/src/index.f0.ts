import { Hono } from 'hono';
import type { AppType, Env } from './types';
import internalApi from './routes/internalApi';
import maintenance from './maintenance';

import { F0_READ_PATHS, readOnlyDatabase } from './lib/financeReadOnly';
const app = new Hono<AppType>();
app.route('/', internalApi);

const f0 = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ status: 'maintenance', service: 'luggage-storage', mode: 'F0', reads: 'signed-finance-only' }),
        { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (request.method !== 'GET' || !F0_READ_PATHS.has(path)) return maintenance.fetch(request);
    const readEnv = new Proxy(env, { get(target, key) {
      if (key === 'DB') return readOnlyDatabase(target.DB);
      // No image access is necessary for the allowlist, including reads with audit side effects.
      if (key === 'IMAGES') throw new Error('F0_R2_BLOCKED');
      return Reflect.get(target, key);
    } });
    const readCtx = new Proxy(ctx, { get(_target, key) {
      if (key === 'waitUntil' || key === 'passThroughOnException') return () => { throw new Error('F0_BACKGROUND_BLOCKED'); };
      return Reflect.get(ctx, key);
    } });
    const response = await app.fetch(request, readEnv, readCtx);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Release-Mode', 'F0');
    return response;
  },
  scheduled: maintenance.scheduled,
} satisfies ExportedHandler<Env>;
export default f0;
