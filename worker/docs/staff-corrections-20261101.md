# Staff order corrections

This feature preserves original receipts while recording corrected claims, quantities, tender classifications and already-returned amounts as append-only events. It never sends money or charges a payment provider.

## Staff workflow

- A final family-wide claim and reason are required. Quantity edits are optional for simple root orders; amount-only corrections preserve existing counts and pricing metadata.
- Orders with additional bags, extension charges or discount-refund history support family-wide amount corrections. Original order, bag-batch, extension and refund records remain intact; a separate adjustment records the difference. Linked quantities are distinguished from amount edits.
- Original receipt amounts and original tenders are immutable. Tender amendments are projected separately. Existing collection confirmation records new money actually received.
- Already-returned money is separate from discount credit. Unknown return tender and unknown exact time are explicit states rather than invented values.

## Closing and QR reconciliation

- Existing authorized staff can correct orders after closing. Saved physical counts and closing snapshots remain unchanged. Current reconciliation displays the change, actor and reason separately.
- A closing can be saved with unknown-tender returns. Their amounts are retained separately; affected reconciliation differences remain unresolved until classification is known.
- QR inputs represent gross daily collections, including the PayPay subset. Recorded QR returns are displayed separately and deducted automatically, including zero-net and return-only negative-net days.
- When an unknown return already included in a closing is later classified, current QR reconciliation is recalculated from that closing's return identifiers. Original saved values remain available.
- Current sales and reconciliation use the current ledger even when an older discount-refund snapshot exists.

## Integrity and release integration

- HMAC, existing session-to-staff mapping and individual part-time identities remain required. This feature adds no account or security role.
- The command rechecks the family, receipts and financial scope in a single D1 batch. Duplicate requests replay the original result; concurrent changes and partial failures cannot leave a half-applied event.
- Events, referenced receipts and audits are protected against ordinary edits, deletion, primary-key/rowid replacement and REPLACE ingress.
- Worker and Admin feature gates default off. Apply and verify the reviewed schema migration before deploying code that requires the new closing columns. Preserve existing deployment configuration and assets.
- Once new records exist, disabling new corrections must preserve the ledger and compatible readers; blindly restoring older financial views is unsafe.

## Tests

Run `npm test` and `npm run lint` from `worker/`. Correction tests use isolated Miniflare D1 and synthetic identities, reserved future-date order identifiers and locally created fixture rows. Profile HTTP requests are intercepted with synthetic responses; no production customer rows or authentication values are used.
