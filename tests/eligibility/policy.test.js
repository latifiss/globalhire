import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHiringPolicy } from "../../src/eligibility/policy.js";

test("accepts explicit worldwide hiring", () => {
  const result = evaluateHiringPolicy("We are remote worldwide and welcome applicants from any country.");
  assert.equal(result.status, "eligible");
  assert.equal(result.policy, "worldwide");
});

test("accepts explicit Ghana hiring", () => {
  const result = evaluateHiringPolicy("We are hiring candidates based in Ghana.");
  assert.equal(result.status, "eligible");
  assert.equal(result.policy, "explicit_country_allowed");
});

test("accepts explicit Africa hiring", () => {
  const result = evaluateHiringPolicy("Applicants based in Africa are eligible to apply.");
  assert.equal(result.status, "eligible");
  assert.equal(result.policy, "africa_allowed");
});

test("rejects an explicit Ghana exclusion even when worldwide language appears", () => {
  const result = evaluateHiringPolicy("We hire worldwide, but cannot hire in Ghana.");
  assert.equal(result.status, "ineligible");
  assert.equal(result.policy, "explicit_country_exclusion");
});

test("rejects a US-only role", () => {
  const result = evaluateHiringPolicy("Candidates must be based in the United States.");
  assert.equal(result.status, "ineligible");
  assert.equal(result.policy, "region_restricted");
});

test("keeps ambiguous remote wording under review", () => {
  const result = evaluateHiringPolicy("This is a remote position with a distributed team.");
  assert.equal(result.status, "review");
  assert.equal(result.policy, "unknown");
});

test("flags conflicting worldwide and region-limited statements for review", () => {
  const result = evaluateHiringPolicy("We hire worldwide. Employees must be based in the United States.");
  assert.equal(result.status, "review");
  assert.equal(result.policy, "conflicting_hiring_evidence");
});

test("keeps company-wide hiring claims under review when country-level restrictions conflict", () => {
  const result = evaluateHiringPolicy("We hire worldwide, but this position requires candidates to be based in the United States.");
  assert.equal(result.status, "review");
  assert.equal(result.policy, "conflicting_hiring_evidence");
});

test("detects a direct Ghana hiring exclusion", () => {
  const result = evaluateHiringPolicy("We cannot employ contractors based in Ghana.");
  assert.equal(result.status, "ineligible");
  assert.equal(result.policy, "explicit_country_exclusion");
});
