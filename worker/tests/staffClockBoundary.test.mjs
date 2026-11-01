import test from 'node:test';
import assert from 'node:assert/strict';
import {correctionPreview} from './helpers/correctionPreview.mjs';
import {fixedTokyoClock} from './helpers/workerClock.mjs';
import {rewriteSqlClock} from './helpers/sqlClock.mjs';

test('SQL clock adapter preserves quoted policy data, comments and bound values', () => {
  const milliseconds=Date.parse('2099-01-02T03:04:05Z');
  const source="SELECT 'now', \"CURRENT_TIMESTAMP\", ?, datetime('now','+9 hours'), strftime('now','now'), CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME; -- datetime('now')\n/* CURRENT_DATE */";
  assert.equal(rewriteSqlClock(source,milliseconds),"SELECT 'now', \"CURRENT_TIMESTAMP\", ?, datetime('2099-01-02T03:04:05.000Z','+9 hours'), strftime('now','2099-01-02T03:04:05.000Z'), '2099-01-02 03:04:05', '2099-01-02', '03:04:05'; -- datetime('now')\n/* CURRENT_DATE */");
  assert.equal(rewriteSqlClock("SELECT json_object('now','now'), datetime(?), note FROM events WHERE note='now'",milliseconds),"SELECT json_object('now','now'), datetime(?), note FROM events WHERE note='now'");
  assert.throws(()=>fixedTokyoClock('24:00:00'),/INVALID_TEST_CLOCK/);
});

const flags={LUGGAGE_BAG_ADDITIONS_ENABLED:'true'};
async function ok(h,path,body,method='POST') {
  const response=await h.request(path,method,body),value=await response.json();
  assert.ok([200,201].includes(response.status),JSON.stringify({status:response.status,value}));return value;
}
const all=(h,table)=>h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(x=>x.results);

test('real staff routes keep the 21:00 guard and permit audited post-close history with paired JS/SQL clocks',async t=>{
  const day=fixedTokyoClock().day;
  await t.test('20:59:59 permits the same-day bag and writes at the same JS and SQL instant',async()=>{
    const clock=fixedTokyoClock('20:59:59',day),h=await correctionPreview({clock,bindings:flags});try{
      const {id}=await h.seed('20991231-991701',4000),path=`/internal/luggage-orders/${id}/bag-additions`;
      const counts={actor:h.actor,suitcaseAdded:0,backpackAdded:1,coverageStartDate:day,coverageEndDate:day};
      const {quote}=await ok(h,path+'/preview',counts);assert.equal(quote.amount,500);
      const additionId=crypto.randomUUID();await ok(h,path,{...counts,additionId,expectedFingerprint:quote.fingerprint,reason:'Synthetic before-cutoff addition',payment:{confirmReceived:true,cashAmount:500,qrAmount:0}});
      assert.equal((await h.db.prepare('SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=?').bind(id).first()).net_received_amount,4500);
      const row=await h.db.prepare("SELECT datetime(created_at) AS written,datetime('now') AS sql_now FROM luggage_bag_additions WHERE addition_id=?").bind(additionId).first();
      assert.equal(row.written,clock.now().toISOString().slice(0,19).replace('T',' '));assert.equal(row.sql_now,row.written);
      await h.db.prepare('CREATE TABLE synthetic_clock_defaults(created_at TEXT DEFAULT CURRENT_TIMESTAMP)').run();
      await h.db.prepare('INSERT INTO synthetic_clock_defaults DEFAULT VALUES').run();
      assert.equal((await h.db.prepare('SELECT created_at FROM synthetic_clock_defaults').first()).created_at,row.sql_now);
      const stale=await h.request(path,'GET',undefined,-3600);assert.equal(stale.status,401);assert.match((await stale.json()).error,/Stale/);
    }finally{await h.close();}
  });
  for(const time of ['21:00:00','21:00:01'])await t.test(`${time} rejects new same-day additions without changing records`,async()=>{
    const clock=fixedTokyoClock(time,day),h=await correctionPreview({clock,bindings:flags});try{
      const {id}=await h.seed('20991231-991702',4000),path=`/internal/luggage-orders/${id}/bag-additions`,before=await all(h,'luggage_order_payments');
      const counts={actor:h.actor,suitcaseAdded:0,backpackAdded:1,coverageStartDate:day,coverageEndDate:day};
      for(const target of [path+'/preview',path]){
        const response=await h.request(target,'POST',target.endsWith('/preview')?counts:{...counts,additionId:crypto.randomUUID(),expectedFingerprint:'0'.repeat(64),reason:'Synthetic blocked addition',payment:{confirmReceived:true,cashAmount:500,qrAmount:0}});
        assert.equal(response.status,409);assert.equal((await response.json()).code,'PICKUP_DEADLINE_PASSED');
      }
      assert.deepEqual(await all(h,'luggage_order_payments'),before);assert.equal((await all(h,'luggage_bag_additions')).length,0);
      assert.equal((await h.db.prepare("SELECT datetime('now') now").first()).now,clock.now().toISOString().slice(0,19).replace('T',' '));
    }finally{await h.close();}
  });
  await t.test('21:01 retains the stale-interval guard while allowing longer coverage and audited closed-day supplements',async()=>{
    const clock=fixedTokyoClock('21:01:00',day),h=await correctionPreview({clock,bindings:flags});try{
      const {id}=await h.seed('20991231-991703',8000),tomorrow=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10),path=`/internal/luggage-orders/${id}/bag-additions`;
      await h.db.prepare('UPDATE luggage_orders SET expected_pickup_at=?,expected_storage_days=2 WHERE order_id=?').bind(tomorrow+'T11:59:00Z',id).run();
      const counts={actor:h.actor,suitcaseAdded:0,backpackAdded:1,coverageStartDate:day,coverageEndDate:tomorrow};
      const {quote}=await ok(h,path+'/preview',counts);assert.equal(quote.amount,1000);
      await ok(h,path,{...counts,additionId:crypto.randomUUID(),expectedFingerprint:quote.fingerprint,reason:'Synthetic longer coverage after cutoff',payment:{confirmReceived:true,cashAmount:1000,qrAmount:0}});
      await h.db.prepare("INSERT INTO luggage_cash_closings(business_date,closing_type,total_amount,actual_amount,expected_amount,check_auto_amount) VALUES(?,'FINAL_CLOSE',9000,9000,9000,9000)").bind(day).run();
      const before={closing:await all(h,'luggage_cash_closings'),receipts:await all(h,'luggage_order_payments'),bags:await all(h,'luggage_bag_additions')};
      const changes={finalAmount:9500,historicalReceipts:[{receiptId:crypto.randomUUID(),amount:500,tenderType:'CASH',businessDate:day,occurredAt:null,timeNote:'Synthetic prior receipt',confirmedAlreadyReceived:true}]};
      const correction=`/internal/luggage-orders/${id}/corrections`,{quote:review}=await ok(h,correction+'/preview',{actor:h.actor,changes});
      const body={actor:h.actor,changes,correctionId:crypto.randomUUID(),expectedFingerprint:review.fingerprint,reason:'Synthetic after-close historical supplement'};
      await ok(h,correction,body);assert.equal((await ok(h,correction,body)).replayed,true);
      const billing=(await ok(h,correction,undefined,'GET')).billing;assert.equal(billing.net_received_amount,9500);assert.equal(billing.outstanding_amount,0);assert.equal(billing.general_returned_amount,0);
      assert.deepEqual(await all(h,'luggage_cash_closings'),before.closing);assert.deepEqual(await all(h,'luggage_bag_additions'),before.bags);
      for(const receipt of before.receipts)assert.deepEqual(await h.db.prepare('SELECT * FROM luggage_order_payments WHERE payment_id=?').bind(receipt.payment_id).first(),receipt);
      assert.equal((await all(h,'luggage_order_payments')).length,before.receipts.length+1);
      await assert.rejects(h.db.prepare("INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at,receipt_request_id) VALUES(?,?,'CASH',1,?,?,?)").bind(id,day,'11111111-1111-4111-8111-111111111111',clock.now().toISOString(),crypto.randomUUID()).run());
    }finally{await h.close();}
  });
});
