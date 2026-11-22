import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{assertClosedHours,bindingSnapshot,assertStaffFlags,assertRefundGuard}from'../scripts/guard-daily-permission-deploy.mjs';
test('closed-hour guard enforces JST boundaries independently of host timezone',()=>{
 for(const d of ['2026-11-20T11:59:59Z','2026-11-20T00:00:00Z'])assert.throws(()=>assertClosedHours(new Date(d)));
 for(const d of ['2026-11-20T12:00:00Z','2026-11-20T23:59:59Z'])assert.doesNotThrow(()=>assertClosedHours(new Date(d)));
});
test('deploy verifies the complete immutable financial guard and rejects historical manager-only schema',()=>{
 const sql=readFileSync('migrations/20261121_staff_late_refund_confirmation.sql','utf8');assert.doesNotThrow(()=>assertRefundGuard(sql));
 assert.throws(()=>assertRefundGuard(sql.replace("OLD.status != 'PAYOUT_PENDING'","OLD.status != 'CONFIRMED'")));
 assert.throws(()=>assertRefundGuard(readFileSync('migrations/20261029_flying_pass_refund_handover.sql','utf8')));
 for(const token of ['NEW.amount IS NOT OLD.amount',"closing_type = 'FINAL_CLOSE'",'NEW.receipt_snapshot IS NOT','luggage_bag_additions ba WHERE ba.order_id=o.order_id'])assert.throws(()=>assertRefundGuard(sql.replaceAll(token,'missing')));
});
test('deployment snapshots detect any changed var/secret/binding without storing raw values',()=>{
 const b=[{name:'FLAG',type:'plain_text',text:'true'},{name:'SECRET',type:'secret_text'},{name:'ASSETS',type:'assets'},{name:'SENTRY_RELEASE',type:'plain_text',text:'old'}];
 assert.deepEqual(bindingSnapshot(b),bindingSnapshot([...b].reverse()));assert.ok(!JSON.stringify(bindingSnapshot(b)).includes('true'));
 assert.notDeepEqual(bindingSnapshot(b),bindingSnapshot([{name:'FLAG',type:'plain_text',text:'false'},b[1]]));
 assert.throws(()=>assertStaffFlags(b));
});
