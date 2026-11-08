import { test } from "node:test";
import assert from "node:assert/strict";
import { INJECT_STALE_MS, uploadUrl } from "../src/index.js";

const DASH = "http://dashboard:3000";
const UP = `${DASH}/uploads/abc`;

// @spec EYES-INJ-015
test("INJECT_STALE_MS is the 60 second staleness window", () => {
  assert.equal(INJECT_STALE_MS, 60_000);
});

// @spec EYES-INJ-005, EARS-INJ-004, EYES-INJ-015
test("uploadUrl accepts only same-origin /uploads/<id>", () => {
  assert.equal(uploadUrl(UP, DASH), UP);
  assert.equal(uploadUrl(`${UP}?x=1`, DASH), `${UP}?x=1`);
  assert.equal(uploadUrl(UP, "http://dashboard:3000/"), UP);
  assert.equal(uploadUrl(`${DASH}/uploads/`, DASH), undefined);
  assert.equal(uploadUrl(`${DASH}/other/abc`, DASH), undefined);
  assert.equal(uploadUrl("http://dashboard:3001/uploads/a", DASH), undefined);
  assert.equal(uploadUrl("https://dashboard:3000/uploads/a", DASH), undefined);
});

// @spec EYES-INJ-005, EARS-INJ-004, EYES-INJ-015
test("uploadUrl rejects credentials, traversal, garbage and missing input", () => {
  assert.equal(uploadUrl("http://u:p@dashboard:3000/uploads/a", DASH), undefined);
  assert.equal(uploadUrl(`${DASH}/uploads/../secret`, DASH), undefined);
  assert.equal(uploadUrl("not a url", DASH), undefined);
  assert.equal(uploadUrl(undefined, DASH), undefined);
  assert.equal(uploadUrl("", DASH), undefined);
  assert.equal(uploadUrl(UP, "not a url"), undefined);
});

// @spec EYES-INJ-005, EYES-INJ-015
test("uploadUrl honours a dashboard base path", () => {
  assert.equal(uploadUrl("http://h/dash/uploads/a", "http://h/dash/"), "http://h/dash/uploads/a");
  assert.equal(uploadUrl("http://h/uploads/a", "http://h/dash"), undefined);
});
