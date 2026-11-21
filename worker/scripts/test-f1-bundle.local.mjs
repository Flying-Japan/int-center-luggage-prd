import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
assert.ok(process.argv[2],'Pass the dry-run F1 bundle path.');
const rootPath=await mkdtemp(join(tmpdir(),'luggage-f1-security-'));
const runtime=new Miniflare({rootPath,script:await readFile(resolve(process.argv[2]),'utf8'),modules:true,
 compatibilityDate:'2025-04-01',compatibilityFlags:['nodejs_compat'],
 bindings:{APP_ENV:'test',APP_SECRET_KEY:'synthetic-local-only'},
 d1Databases:{DB:'synthetic-local-only'},r2Buckets:['IMAGES'],d1Persist:false,r2Persist:false,
 outboundService(){throw new Error('External requests are forbidden in the local bundle test.');}});
try {
 const login=await runtime.dispatchFetch('https://synthetic.invalid/staff/login');
 assert.equal(login.status,200);assert.match(await login.text(),/Staff Login/);
 const escaped=await runtime.dispatchFetch('https://synthetic.invalid/staff/login?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
 const html=await escaped.text();assert.ok(!html.includes('<img src=x onerror=alert(1)>'));assert.match(html,/&lt;img/);
 const staff=await runtime.dispatchFetch('https://synthetic.invalid/staff',{redirect:'manual'});
 assert.equal(staff.status,302);assert.match(staff.headers.get('location'),/\/staff\/login/);
 console.log('PASS: F1 production bundle starts in workerd; login/escaping/auth boundary pass without external access.');
} finally {await runtime.dispose();await rm(rootPath,{recursive:true,force:true});}
