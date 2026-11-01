import { createRequire } from 'node:module';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync,execFileSync } from 'node:child_process';
const root=process.argv[2],expected=process.argv[3];
if(!root||!expected)throw Error('Pass the read-only Account checkout path and fixed HEAD. No implicit skips.');
if(!/^[a-f0-9]{40}$/.test(expected))throw Error('Pass an exact immutable commit SHA');
const account=resolve(root);
const fixed=execFileSync('git',['-C',account,'rev-parse',`${expected}^{commit}`],{encoding:'utf8'}).trim();
if(fixed!==expected)throw Error('ACCOUNT_COMMIT_MISMATCH');
const signer='src/lib/luggage/customer-context.ts';
// The other agent may advance HEAD. Read the named immutable object, never its
// changing working tree, and never check out/edit files in their workspace.
const source=execFileSync('git',['-C',account,'show',`${expected}:${signer}`],{encoding:'utf8'});
if(/^\s*import\s/m.test(source))throw Error('Signer gained dependencies; freeze and review them explicitly first');
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const temp=await mkdtemp(join(tmpdir(),'luggage-account-hardening-'));
try{
  const frozen=join(temp,'account-signer.ts');await writeFile(frozen,source);
  const output=join(temp,'contract.cjs');await build({entryPoints:['tests/accountHandoffHardening.test.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',target:'node22',alias:{'account-handoff-signer':frozen}});
  console.log('Read-only Account signer HEAD:',expected);
  const result=spawnSync(process.execPath,['--test',output],{stdio:'inherit',env:{...process.env,TZ:'UTC'}});
  process.exitCode=result.status??1;
}finally{await rm(temp,{recursive:true,force:true});}
