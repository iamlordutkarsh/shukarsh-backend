/**
 * Whether an order may be paid in cash at the door, and what that costs.
 *
 * Two rules, both about risk rather than convenience. The fee is what the
 * courier charges to collect and remit cash, passed on rather than absorbed,
 * which also filters out the orders nobody intends to accept. The cap exists
 * because a refused COD parcel costs the shop both legs of shipping and returns
 * goods that may no longer be sellable, and that exposure grows with the cart.
 */

const DEFAULT_FEE = 49;
const DEFAULT_MAX = 3000;

export interface CodPolicy {
  fee: number;
  /** The most the courier may be asked to collect, fee included. */
  maxCollectable: number;
  enabled: boolean;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function codPolicy(): CodPolicy {
  return {
    fee: positiveNumber(process.env.COD_FEE, DEFAULT_FEE),
    maxCollectable: positiveNumber(process.env.COD_MAX, DEFAULT_MAX),
    // Off switches the option out of checkout entirely, for a week when nobody
    // is around to chase undelivered parcels.
    enabled: process.env.COD_ENABLED !== "false",
  };
}

/**
 * Judged on the whole collectable amount, fee included, because that is the sum
 * at risk at the door, not the value of the goods.
 */
export function codAllowed(collectable: number): boolean {
  const { enabled, maxCollectable } = codPolicy();
  return enabled && collectable > 0 && collectable <= maxCollectable;
}

/**
 * What COD would add to a total that is otherwise final.
 *
 * Returns the fee and the resulting amount together, so a caller cannot add one
 * without checking the other against the cap.
 */
export function codCharge(prepaidTotal: number): { fee: number; collectable: number; allowed: boolean } {
  const { fee } = codPolicy();
  const collectable = Math.round((prepaidTotal + fee) * 100) / 100;
  return { fee, collectable, allowed: codAllowed(collectable) };
}
