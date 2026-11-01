// Local-only browser harness. No Worker bindings, auth, production data or network writes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const storeModule = await readFile(new URL('../client/intakeDraftStore.mjs', import.meta.url));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local intake draft checks</title>
<style>body{font:18px system-ui;max-width:850px;margin:40px auto}button{font:inherit;padding:12px}pre{white-space:pre-wrap}</style>
<h1>Local intake draft checks</h1><p>Synthetic photos only. No live accounts, orders or external calls.</p>
<button id="run">Run IndexedDB and reload checks</button><pre id="result">Ready</pre>
<script type="module">
import {createBrowserDraftStore} from '/intakeDraftStore.mjs';
const result=document.querySelector('#result');
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const store=createBrowserDraftStore();
const pending=sessionStorage.getItem('test-draft-id');
if(pending){
 try{
  const draft=await store.load(pending);
  assert(draft.contact.phone==='000-1234-5678','contact restored after reload');
  assert(await draft.photos.identity.blob.text()==='SYNTHETIC-ID','ID bytes restored after reload');
  assert(await draft.photos.luggage.blob.text()==='SYNTHETIC-BAGS','bag bytes restored after reload');
  await store.remove(pending); sessionStorage.removeItem('test-draft-id');
  result.textContent=sessionStorage.getItem('test-results')+'\\nPASS full page reload restores contact and both photo bytes\\nPASS removes completed synthetic draft\\nALL 7 CHECKS PASSED';
 }catch(error){result.textContent='FAIL '+error.message;}
}
document.querySelector('#run').onclick=async()=>{
 const logs=[];
 try{
  await store.purgeExpired();
  const born=Date.now();const draft={version:2,boundary:{mode:'guest'},createdAt:born,expiresAt:born+1800000,id:crypto.randomUUID(),revision:1,contact:{name:'Sample',phone:'000-1234-5678',email:'sample@example.invalid'},
    photos:{identity:{blob:new Blob(['SYNTHETIC-ID'],{type:'image/png'}),name:'id.png',lastModified:1},luggage:{blob:new Blob(['SYNTHETIC-BAGS'],{type:'image/jpeg'}),name:'bags.jpg',lastModified:2}}};
  await store.save(draft); const restored=await store.load(draft.id);
  assert(await restored.photos.identity.blob.text()==='SYNTHETIC-ID','photo bytes round trip');
  logs.push('PASS actual IndexedDB stores/restores photo-bearing encrypted snapshot');
  let staleRejected=false;try{await store.save({...draft,revision:0});}catch{staleRejected=true;}
  assert(staleRejected,'old revision blocked');logs.push('PASS stale asynchronous save cannot overwrite newer draft');
  assert((await store.load(draft.id)).revision===1,'newer revision retained');
  logs.push('PASS aborted transaction preserves existing revision');
  let clock=1000; const expiryStore=createBrowserDraftStore({now:()=>clock});
  const expiring={...draft,id:crypto.randomUUID(),createdAt:clock,expiresAt:clock+1800000};await expiryStore.save(expiring);clock+=30*60*1000+1;
  assert(await expiryStore.load(expiring.id)===null,'expired draft removed');logs.push('PASS 30 minute expiry removes draft');
  let expiredSaveRejected=false;try{await expiryStore.save({...expiring,revision:2,updatedAt:clock});}catch(error){expiredSaveRejected=error.message==='DRAFT_EXPIRED';}assert(expiredSaveRejected&&await expiryStore.load(expiring.id)===null,'expired draft never revived');logs.push('PASS save after expiry cannot renew the same photos for another 30 minutes');
  sessionStorage.setItem('test-draft-id',draft.id);sessionStorage.setItem('test-results',logs.join('\\n'));
  location.reload();
 }catch(error){result.textContent=logs.join('\\n')+'\\nFAIL '+error.message;}
};
</script></html>`;
createServer((request,response)=>{
  if(request.url==='/intakeDraftStore.mjs'){response.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});response.end(storeModule);}
  else if(request.url==='/'){response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});response.end(html);}
  else {response.writeHead(404);response.end();}
}).listen(8796,'127.0.0.1',()=>process.stdout.write('Synthetic draft harness: http://127.0.0.1:8796/\n'));
