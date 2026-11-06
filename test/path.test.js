import test from "node:test";
import assert from "node:assert/strict";
import { validatePathData } from "../core/path.js";

test("accepts absolute and relative geometry commands", () => {
  assert.equal(validatePathData("M10 10 L90 10 H50 V80 C20 20 40 40 60 60 Z").ok, true);
  assert.equal(validatePathData("m0 0 l10 10 h5 v5 c1 2 3 4 5 6 z").ok, true);
  assert.equal(validatePathData("M0 0 Q50 100 100 0 T200 0").ok, true);
  assert.equal(validatePathData("M0 0 A50 50 0 0 1 100 100").ok, true);
});

test("rejects data that is not a path", () => {
  assert.equal(validatePathData("").ok, false);
  assert.equal(validatePathData("<script>alert(1)</script>").ok, false);
  assert.equal(validatePathData("M0 0 url(#x)").ok, false);
  assert.equal(validatePathData("L10 10").ok, false, "must start with M");
});

test("rejects wrong argument counts", () => {
  assert.equal(validatePathData("M10").ok, false);
  assert.equal(validatePathData("M10 10 C20 20 30 30").ok, false);
  assert.equal(validatePathData("M0 0 A10 10 0 2 1 20 20").ok, false, "arc flags are 0/1");
});

test("rejects coordinates outside the allowed range", () => {
  assert.equal(validatePathData("M0 0 L5000 10").ok, false);
  assert.equal(validatePathData("M0 0 L-900 10").ok, false);
});

test("enforces length and command limits", () => {
  assert.equal(validatePathData("M0 0 L1 1", { maxLength: 4 }).ok, false);
  assert.equal(validatePathData("M0 0 L1 1 L2 2 L3 3", { maxCommands: 2 }).ok, false);
});