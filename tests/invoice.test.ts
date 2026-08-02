import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { financialYear, formatInvoiceNumber } from "../src/lib/invoice";

/**
 * The series a number belongs to, which is the part with no second chance.
 *
 * An invoice number has to be unique within a financial year. Start the year in
 * January rather than April and the series resets three months early, handing
 * out a second SHK/26-27/0001 to a different customer — and rule 46 offers no
 * way to correct a number that has already been printed and posted.
 *
 * The counter itself needs a database and is covered by `npm run check:tax`'s
 * neighbour, `scripts/check-invoice.ts`.
 */
describe("financialYear", () => {
  it("starts a new year on the first of April", () => {
    assert.equal(financialYear(new Date("2026-04-01T00:00:00Z")), "26-27");
  });

  it("keeps March with the year that began the previous April", () => {
    assert.equal(financialYear(new Date("2026-03-31T12:00:00Z")), "25-26");
  });

  /**
   * The boundary as India sees it, not as the server does. Render runs in UTC,
   * where both of these are still 31 March.
   */
  it("turns the year over at midnight in India, not at midnight UTC", () => {
    // 00:30 IST on 1 April, which is 19:00 UTC on 31 March.
    assert.equal(financialYear(new Date("2026-03-31T19:00:00Z")), "26-27");
    // 23:00 IST on 31 March, still the old year.
    assert.equal(financialYear(new Date("2026-03-31T17:30:00Z")), "25-26");
  });

  it("puts January in the year that started the year before", () => {
    assert.equal(financialYear(new Date("2027-01-15T00:00:00Z")), "26-27");
  });

  it("rolls the century over without a gap", () => {
    assert.equal(financialYear(new Date("2099-05-01T00:00:00Z")), "99-00");
  });
});

describe("formatInvoiceNumber", () => {
  it("pads the sequence so the numbers sort", () => {
    assert.equal(formatInvoiceNumber("26-27", 1), "SHK/26-27/0001");
    assert.equal(formatInvoiceNumber("26-27", 42), "SHK/26-27/0042");
  });

  it("stays inside the sixteen characters rule 46 allows", () => {
    assert.ok(formatInvoiceNumber("26-27", 9999).length <= 16);
  });

  it("keeps growing rather than truncating past four digits", () => {
    assert.equal(formatInvoiceNumber("26-27", 12345), "SHK/26-27/12345");
  });
});
