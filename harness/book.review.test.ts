// Independent review harness (Cian) for the ccd015 redemption book.
// Distinct from the author suite and the filed submissions: it measures exact
// escrow conservation on a partial frontier fill, bounds the truncation premium
// the DAO can ever pay, checks the kept / above-par path, the ascending-sort
// invariant across a scripted place/change/cancel sequence, and eviction refund
// accounting. Every assertion is a property, not a golden value.
//
// Run: RUN_CCD015_BOOK=1 npx vitest run --config tests/audit/vitest.audit.config.ts \
//        tests/audit/book.review.test.ts
import { test } from 'vitest';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { initSimnet } from '@stacks/clarinet-sdk';
import { Cl, cvToString } from '@stacks/transactions';

const bookManifest = resolve('tests/vault/.build/Clarinet.toml');

test('ccd015 book: conservation, truncation bound, sort invariant, eviction refund', async () => {
  const sim = await initSimnet(bookManifest, true);
  const accounts = sim.getAccounts();
  const admin = accounts.get('deployer');
  const alice = accounts.get('wallet_1');
  const bob = accounts.get('wallet_2');
  const carol = accounts.get('wallet_3');
  const w4 = accounts.get('wallet_4');
  const w5 = accounts.get('wallet_5');
  const w6 = accounts.get('wallet_6');
  const w7 = accounts.get('wallet_7');
  const B = 'ccd015-redemption-book-mia-stx';
  const u = Cl.uint;
  const cp = name => Cl.contractPrincipal(admin, name);
  const call = (fn, args = [], sender = alice) => sim.callPublicFn(B, fn, args, sender);
  const gov = (fn, args = []) => sim.callPublicFn('mock-book-extension', fn, args, admin);
  const read = (fn, args = []) => sim.callReadOnlyFn(B, fn, args, admin).result;
  const rc = (contract, fn, args = []) => sim.callReadOnlyFn(contract, fn, args, admin).result;
  const ok = r => { assert.equal(r.result.type, 'ok', cvToString(r.result)); return r.result.value; };
  const err = (r, code) => assert.equal(cvToString(r.result), `(err u${code})`);
  const stx = who => sim.getAssetsMap().get('STX')?.get(who) ?? 0n;
  const mia = who => rc('mock-mia', 'get-balance', [Cl.principal(who)]).value.value;
  const supply = () => rc('mock-mia', 'get-total-supply').value.value;
  const book = () => read('get-offer-book').value;
  const parFor = amount => read('get-par-ustx', [u(amount)]).value;
  const burned = () => BigInt(cvToString(read('get-info')).match(/total-burned-mia u(\d+)/)[1]);
  const asc = list => {
    for (let k = 1; k < list.length; k += 1) {
      const f = (cv, key) => { const t = cv.value; const v = t[key] ?? t.value?.[key]; return BigInt(v.value); };
      const au = f(list[k - 1], 'ustx'), aa = f(list[k - 1], 'amount');
      const bu = f(list[k], 'ustx'), ba = f(list[k], 'amount');
      assert.ok(au * ba <= bu * aa,
        `sort violated at ${k}: ${cvToString(list[k - 1])} then ${cvToString(list[k])}`);
    }
  };

  // Production identity: extension-gated admin, live par, small min-deposit.
  ok(sim.callPublicFn('mock-base-dao', 'set-extension', [cp('mock-book-extension'), Cl.bool(true)], admin));
  ok(gov('set-paused', [Cl.bool(false)]));
  ok(gov('set-min-deposit', [u(10)]));
  ok(sim.transferSTX(1n, `${admin}.${B}`, admin));
  ok(gov('update-par'));
  const par = read('get-par-scaled').value;

  // ---- 1. Exact conservation on a partial frontier fill -------------------
  ok(call('place-offer', [u(1000), u(parFor(1000))], alice)); // at exactly par
  const ask = parFor(1000);
  const budget = ask / 3n;
  ok(sim.transferSTX(budget, `${admin}.${B}`, admin));
  const balBefore = stx(`${admin}.${B}`);
  const supplyBefore = supply();
  const r1 = ok(call('cross-book', [], bob));
  const num = (cv, field) => BigInt(cvToString(cv).match(new RegExp(`\\(${field} u(\\d+)\\)`))[1]);
  const spent = num(r1, 'spent');
  const acquired = num(r1, 'acquired');

  // cross-book drains the ENTIRE book balance into the marginal offer; the
  // bootstrap 1 uSTX is part of it, which is why spent == balBefore, not budget.
  assert.equal(balBefore - stx(`${admin}.${B}`), spent, 'STX out == spent');
  assert.equal(spent, balBefore, 'cross-book spends the entire book balance');
  assert.equal(supplyBefore - supply(), acquired, 'MIA burned == acquired');
  assert.equal(burned(), acquired);
  assert.equal(acquired, (1000n * balBefore) / ask, 'acquired == floor(amount*remaining/ask)');
  console.log('T1 ask/1000MIA=%s book-bal=%s spent=%s acquired=%s linear=%s overpay=%s',
    ask, balBefore, spent, acquired, (acquired * ask) / 1000n, spent - (acquired * ask) / 1000n);

  // ---- 2. Truncation bound: never under-pays the seller; over-pay < price
  //         of ONE micro-MIA (i.e. < ask/1000 uSTX, sub-cent dust) ---------
  assert.ok(spent * 1000n >= acquired * ask, 'seller never under-paid');
  assert.ok(spent * 1000n - acquired * ask < ask, 'over-pay bounded by one micro-MIA of ask (dust)');
  // realized unit price stays at or below the DAO par ceiling (+ <1 uSTX slack)
  assert.ok(spent * 100000000n < acquired * par + par, 'realized price at or below par ceiling');

  // ---- 3. A now-above-par resting offer is kept, never purchased ----------
  ok(gov('update-par'));
  const par2 = read('get-par-scaled').value;
  // alice's stub sits at exactly the old (<=new) ask; leave it, add a cheap deal.
  ok(call('place-offer', [u(1000), u(1)], bob));
  ok(sim.transferSTX(2n, `${admin}.${B}`, admin));
  const burnedBefore = burned();
  const r3 = ok(call('cross-book', [], carol));
  const acq3 = BigInt(cvToString(r3).match(/\(acquired u(\d+)\)/)[1]);
  // the 1-uSTX bob offer clears; alice's par-priced stub remains on the book
  assert.ok(cvToString(read('get-offer', [Cl.principal(alice)])).includes('(amount'),
    'par-priced stub kept, not bought for a budget it does not fit');
  assert.equal(burned(), burnedBefore + acq3);

  // ---- 4. Ascending sort holds through place / change-up / change-down / cancel
  const pq = parFor(1000); // uSTX ask for 1000 MIA at exactly par
  assert.ok(pq > 0n);
  for (const [who, div] of [[w4, 1n], [w5, 2n], [w6, 3n], [w7, 5n]]) {
    const rp = call('place-offer', [u(1000), u(pq / div)], who);
    assert.equal(rp.result.type, 'ok', `place ${div}: ${cvToString(rp.result)}`);
    asc(book());
  }
  ok(call('change-offer', [Cl.none(), u(pq * 9n / 10n)], w6)); // price up
  asc(book());
  ok(call('change-offer', [Cl.none(), u(1n)], w5));             // price down
  asc(book());
  ok(call('cancel-offer', [], w7));
  asc(book());
  assert.ok(book().length <= 50);

  console.log('T4 book-len-after-cancel=%s', BigInt(book().length));
});
// Fresh simnet so every mock seller holds a distinct, unused slot: fills the
// book to the hard cap and proves eviction refunds rather than burns.
test('ccd015 book: 50-offer cap and eviction refund on a fresh ledger', async () => {
  const sim = await initSimnet(bookManifest, true);
  const accounts = sim.getAccounts();
  const admin = accounts.get('deployer');
  const B = 'ccd015-redemption-book-mia-stx';
  const u = Cl.uint;
  const cp = name => Cl.contractPrincipal(admin, name);
  const read = (fn) => sim.callReadOnlyFn(B, fn, [], admin).result;
  const rc = (c, fn, args) => sim.callReadOnlyFn(c, fn, args, admin).result;
  const cv = (r) => cvToString(r);
  const miaOf = who => rc('mock-mia', 'get-balance', [Cl.principal(who)]).value.value;

  sim.callPublicFn('mock-base-dao', 'set-extension', [cp('mock-book-extension'), Cl.bool(true)], admin);
  sim.callPublicFn('mock-book-extension', 'set-min-deposit', [u(10)], admin);
  sim.transferSTX(1n, `${admin}.${B}`, admin);
  sim.callPublicFn('mock-book-extension', 'update-par', [], admin);
  const pq = sim.callReadOnlyFn(B, 'get-par-ustx', [u(1000)], admin).result.value;

  // sellers 0..49, strictly ascending price pq/(i+1) -> 50 distinct offers
  for (let i = 0; i < 50; i += 1) {
    const r = sim.callPublicFn(`mock-book-seller-${i}`, 'place', [u(1000), u(pq / BigInt(i + 1))], admin);
    assert.equal(r.result.type, 'ok', `seller ${i}: ${cv(r.result)}`);
  }
  assert.equal(read('get-offer-count').value, 50n, 'book is exactly at the cap');
  const list = read('get-offer-book').value;
  for (let k = 1; k < list.length; k += 1) {
    const f = (cv2, key) => { const t = cv2.value; const v = t[key] ?? t.value?.[key]; return BigInt(v.value); };
    assert.ok(f(list[k - 1], 'ustx') * f(list[k], 'amount') <= f(list[k], 'ustx') * f(list[k - 1], 'amount'),
      `cap list not ascending at ${k}`);
  }

  const worst = list[list.length - 1];
  const worstOwner = (worst.value.owner ?? worst.value.value.owner).value;
  const evictedAmount = BigInt((worst.value.amount ?? worst.value.value.amount).value);
  const miaBefore = miaOf(worstOwner);
  // seller-50 offers strictly cheaper than every resting offer -> admits and evicts
  const rev = sim.callPublicFn('mock-book-seller-50', 'place', [u(1000), u(1n)], admin);
  assert.equal(rev.result.type, 'ok', cv(rev.result));
  assert.equal(read('get-offer-count').value, 50n, 'cap still 50 after eviction');
  assert.ok(miaOf(worstOwner) > miaBefore, 'evicted seller got MIA back');
  assert.equal(miaOf(worstOwner) - miaBefore, evictedAmount, 'refund is exactly the evicted amount');
  console.log('T5 cap=50 evicted-amount=%s refunded=%s', evictedAmount, miaOf(worstOwner) - miaBefore);

  // an equal-or-worse newcomer is refused, and the book is unchanged
  // seller-0 was evicted (it was the most expensive). A full book refuses an
  // offer that is not strictly cheaper than the worst resting one.
  const worse = sim.callPublicFn('mock-book-seller-0', 'place', [u(1000), u(pq)], admin);
  assert.equal(cv(worse.result), '(err u15003)', 'full book refuses a not-cheaper offer');
  assert.equal(read('get-offer-count').value, 50n, 'count unchanged by the refusal');
});
