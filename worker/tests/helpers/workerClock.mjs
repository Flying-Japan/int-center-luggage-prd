// Test-only clock. Never imported by product code or deployment entry points.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function fixedTokyoClock(time = '13:00:00', day = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo'}).format(new Date())) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw Error('INVALID_TEST_CLOCK');
  const milliseconds = Date.parse(`${day}T${time}+09:00`);
  if (!Number.isFinite(milliseconds) || new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(milliseconds)) !== day) throw Error('INVALID_TEST_CLOCK');
  return Object.freeze({milliseconds, day, now:()=>new Date(milliseconds)});
}

export function writeWorkerClockInjection(directory, clock) {
  if (!Number.isSafeInteger(clock?.milliseconds)) throw Error('INVALID_TEST_CLOCK');
  const path = join(directory, 'test-clock.mjs');
  // esbuild inject rewrites free Date references only in this temporary test
  // bundle. The host Date and product files stay untouched; sqlClock.mjs pairs
  // SQLite clock expressions with this instant at the test binding boundary.
  writeFileSync(path, `const RealDate=globalThis.Date;const milliseconds=${clock.milliseconds};
const ClockDate=new Proxy(RealDate,{
 construct(target,args,newTarget){return Reflect.construct(target,args.length?args:[milliseconds],newTarget);},
 apply(){return new RealDate(milliseconds).toString();},
 get(target,key){return key==='now'?()=>milliseconds:Reflect.get(target,key);}
});export{ClockDate as Date};\n`);
  return path;
}
