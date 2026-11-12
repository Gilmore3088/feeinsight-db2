// The publish rule: plain code, no model, no database, no switches. It says which status a
// fee moves to after a quote check. Rules are written out in docs/fee-record.md.

import { QUOTE_CHECK_VERSION, type CheckResult } from './quote-check.ts';
import { validateFee, type FeeRecord, type Status } from './record.ts';

export interface Step { status: Status; withdrawalReason: string | null }

/** A fee may go live only when it is checked, is still a valid record, and the check it
 * passed is today's version of the check. */
export function canGoLive(r: FeeRecord): boolean {
  return r.status === 'checked' && r.quoteCheckedAt != null &&
    r.quoteCheckVersion === QUOTE_CHECK_VERSION && validateFee(r).length === 0;
}

/** Where a fee goes after a quote check. One step at a time:
 *  - read: to checked when the check passes; otherwise it stays read.
 *  - checked: to live when the check passes again and canGoLive holds. A pass under an older
 *    version of the check leaves it checked. A failed check sends it back to read.
 *  - live: stays live while the check passes. A failed check withdraws it, and the reason
 *    is what the check found.
 *  - withdrawn: stays withdrawn. A fee that comes back is read again as a new row. */
export function nextStatus(r: FeeRecord, check: CheckResult): Step {
  const stay: Step = { status: r.status, withdrawalReason: r.withdrawalReason };
  switch (r.status) {
    case 'withdrawn': return stay;
    case 'read': return check.ok ? { status: 'checked', withdrawalReason: null } : stay;
    case 'checked':
      if (!check.ok) return { status: 'read', withdrawalReason: null };
      return canGoLive(r) ? { status: 'live', withdrawalReason: null } : stay;
    case 'live':
      return check.ok ? stay : { status: 'withdrawn', withdrawalReason: `quote check failed: ${check.problems.join('; ')}` };
    default: throw new RangeError(`unknown status "${(r as FeeRecord).status}"`);
  }
}

/** The record after a quote check: its next status, and the stamp of the check. A pass
 * stamps the time and version; a fail clears the stamp unless the fee is already withdrawn. */
export function applyCheck(r: FeeRecord, check: CheckResult, now: Date): FeeRecord {
  if (r.status === 'withdrawn') return r;
  const stamp = check.ok
    ? { quoteCheckedAt: now.toISOString(), quoteCheckVersion: QUOTE_CHECK_VERSION }
    : { quoteCheckedAt: null, quoteCheckVersion: null };
  return { ...r, ...nextStatus(r, check), ...stamp };
}

/** Withdraw a fee from any status. The row is kept; a reason is required. */
export function withdraw(r: FeeRecord, reason: string): FeeRecord {
  if (typeof reason !== 'string' || reason.trim() === '') throw new RangeError('a withdrawn fee needs a reason');
  return { ...r, status: 'withdrawn', withdrawalReason: reason.trim() };
}
