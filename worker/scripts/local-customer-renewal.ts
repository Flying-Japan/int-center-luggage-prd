/** Local in-memory renewal server. Never connects to Wrangler, OAuth or remote services. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { customerFixture } from '../tests/helpers/customerFixture';
import { syntheticPng } from '../tests/helpers/syntheticPhoto';
const c = customerFixture();
const port = Number(process.env.CUSTOMER_LOCAL_PORT ?? 8797);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('INVALID_LOCAL_PORT');
c.env.ACCOUNT_CONTEXT_SECRET = 'synthetic-local-account-context-only';
const font = readFileSync('customer-ui/v8/assets/PretendardJPVariable.woff2');
c.objects.set('static/customer-renewal/PretendardJPVariable.woff2', { body: font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength), contentType: 'font/woff2' });
globalThis.fetch = async () => { throw Error('LOCAL_HARNESS_EXTERNAL_FETCH_FORBIDDEN'); };
createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403); response.end(); return; }
    const url = new URL(request.url!, `http://127.0.0.1:${port}`);
    if (request.method === 'POST') console.log('Local synthetic POST received:', url.pathname);
    if (url.pathname === '/__local/checks') {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(readFileSync('tests/browser/customerRenewal.html')); return;
    }
    if (url.pathname === '/__local/boundary-checks') {
      response.writeHead(200, { 'content-type':'text/html', 'cache-control':'no-store' });response.end(readFileSync('tests/browser/customerBoundary.html'));return;
    }
    if (url.pathname === '/__local/input-controls-checks') {
      response.writeHead(200, { 'content-type':'text/html', 'cache-control':'no-store' });response.end(readFileSync('tests/browser/customerInputControls.html'));return;
    }
    if (url.pathname === '/__local/store.mjs') {
      response.writeHead(200, { 'content-type':'text/javascript', 'cache-control':'no-store' });response.end(readFileSync('client/intakeDraftStore.mjs'));return;
    }
    if (url.pathname === '/__local/photo.png') {
      response.writeHead(200, { 'content-type':'image/png','cache-control':'no-store' });response.end(syntheticPng('local-browser-fixture'));return;
    }
    if (url.pathname === '/__local/summary') {
      response.writeHead(200, { 'content-type':'application/json','cache-control':'no-store' });response.end(JSON.stringify({orders:c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n}));return;
    }
    if (url.pathname === '/__local/reset' || url.pathname === '/__local/logout') {
      response.writeHead(302, { location: '/customer/renewal?lang=en', 'set-cookie': 'fj_account_context=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'cache-control': 'no-store' });
      response.end(); return;
    }
    if (url.pathname === '/__local/member') {
      const account = ['A','B'].includes(url.searchParams.get('as')!) ? url.searchParams.get('as')! : '';
      const data = { timestamp: new Date().toISOString(), person_id: account ? `SYNTHETIC-BROWSER-${account}` : 'SYNTHETIC-BROWSER-PERSON',
        email: 'synthetic-member@example.invalid', provider: 'google', display_name: account ? `Synthetic Member ${account}` : 'Synthetic Member', phone: '', locale: 'en' };
      const canonical = [data.timestamp,data.person_id,data.email,data.provider,data.display_name,data.phone,data.locale].join('\n');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.ACCOUNT_CONTEXT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))).toString('base64url');
      const value = Buffer.from(JSON.stringify({ ...data, signature })).toString('base64url');
      response.writeHead(302, { 'location': '/customer/renewal?lang=en', 'set-cookie': `fj_account_context=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`, 'cache-control': 'no-store' });
      response.end(); return;
    }
    const buffers = []; for await (const chunk of request) buffers.push(chunk);
    const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const req = new Request(url, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method!) ? undefined : Buffer.concat(buffers) });
    const result = await c.app.fetch(req, c.env, { waitUntil() { throw Error('LOCAL_HARNESS_OUTBOUND_SIDE_EFFECT_FORBIDDEN'); }, passThroughOnException() {}, props: {} });
    if (request.method === 'POST') console.log('Local synthetic POST status:', result.status);
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { console.error(error); response.writeHead(500); response.end('LOCAL_TEST_ERROR'); }
}).listen(port, '127.0.0.1', () => console.log(`Synthetic renewal server: http://127.0.0.1:${port}/customer/renewal · checks: /__local/checks`));
