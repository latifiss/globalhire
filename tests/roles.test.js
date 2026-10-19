import test from "node:test";
import assert from "node:assert/strict";
import { matchRole } from "../src/roles/matcher.js";

test("matches product and founding designers", () => {
  assert.equal(matchRole("Founding Product Designer").matched, true);
  assert.ok(matchRole("Founding Product Designer").families.includes("product_design"));
});

test("matches design engineering roles", () => {
  assert.ok(matchRole("Design Engineer").families.includes("design_engineering"));
});

test("matches relevant frontend roles", () => {
  assert.ok(matchRole("Frontend Engineer", "React, TypeScript and design systems").matched);
});

test("does not match unrelated jobs", () => {
  assert.equal(matchRole("Accountant", "Monthly reporting and invoices").matched, false);
});
