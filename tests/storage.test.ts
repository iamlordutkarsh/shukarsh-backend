import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { isCustomerUpload, objectPathFromUrl } from "../src/lib/storage";

/**
 * Which URLs count as ours.
 *
 * This is the only thing standing between a return request and an admin queue
 * rendering whatever address a browser chose to send. The path alone is not
 * enough to decide it: anyone can put `/storage/v1/object/public/<bucket>/` in a
 * URL on their own domain, and a check that only searched for that substring
 * waved it straight through.
 */
describe("objectPathFromUrl", () => {
  const ORIGIN = "https://abcdefgh.supabase.co";
  const previousUrl = process.env.SUPABASE_URL;

  // The bucket is read once at module load, so these run against its default,
  // `product-images`. SUPABASE_URL is read per call and can be set here.
  beforeEach(() => {
    process.env.SUPABASE_URL = ORIGIN;
  });

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
  });

  it("reads the object path out of one of our own URLs", () => {
    assert.equal(
      objectPathFromUrl(`${ORIGIN}/storage/v1/object/public/product-images/returns/2026-08/a.jpg`),
      "returns/2026-08/a.jpg"
    );
  });

  it("refuses the same path on somebody else's domain", () => {
    assert.equal(
      objectPathFromUrl("https://evil.example.com/storage/v1/object/public/product-images/returns/a.jpg"),
      null
    );
  });

  it("refuses a URL that only mentions the marker further along", () => {
    assert.equal(
      objectPathFromUrl(`https://evil.example.com/x/storage/v1/object/public/product-images/returns/a.jpg`),
      null
    );
    assert.equal(
      objectPathFromUrl(`https://evil.example.com/?u=${ORIGIN}/storage/v1/object/public/product-images/returns/a.jpg`),
      null
    );
  });

  it("is not fooled by our origin appearing in the host", () => {
    assert.equal(
      objectPathFromUrl("https://abcdefgh.supabase.co.evil.example.com/storage/v1/object/public/product-images/returns/a.jpg"),
      null
    );
  });

  it("refuses a different bucket on our own domain", () => {
    assert.equal(objectPathFromUrl(`${ORIGIN}/storage/v1/object/public/other/returns/a.jpg`), null);
  });

  it("refuses something that is not a URL at all", () => {
    assert.equal(objectPathFromUrl("returns/a.jpg"), null);
  });

  it("refuses everything when there is no configured bucket to compare against", () => {
    delete process.env.SUPABASE_URL;
    assert.equal(
      objectPathFromUrl(`${ORIGIN}/storage/v1/object/public/product-images/returns/a.jpg`),
      null
    );
  });

  describe("isCustomerUpload", () => {
    it("accepts a photo under the customer prefix", () => {
      assert.equal(
        isCustomerUpload(`${ORIGIN}/storage/v1/object/public/product-images/returns/2026-08/a.jpg`),
        true
      );
    });

    it("refuses a catalogue image, which no customer uploaded", () => {
      assert.equal(
        isCustomerUpload(`${ORIGIN}/storage/v1/object/public/product-images/2026-08/a.jpg`),
        false
      );
    });

    it("refuses an address on another domain however it is dressed up", () => {
      assert.equal(
        isCustomerUpload("https://evil.example.com/storage/v1/object/public/product-images/returns/a.jpg"),
        false
      );
    });
  });
});
