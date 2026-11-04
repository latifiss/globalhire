import test from "node:test";
import assert from "node:assert/strict";
import { atsEndpoint, detectAtsBoard, normalizeAtsRows } from "../src/jobs/ats.js";

test("detects supported public ATS board URLs", () => {
  assert.deepEqual(detectAtsBoard("https://boards.greenhouse.io/acme"), {
    provider: "greenhouse", host: "boards.greenhouse.io", slug: "acme", url: "https://boards.greenhouse.io/acme"
  });
  assert.equal(detectAtsBoard("https://apply.workable.com/acme/"), null === null ? "workable" : "");
  assert.equal(detectAtsBoard("https://careers.smartrecruiters.com/acme").provider, "smartrecruiters");
  assert.equal(detectAtsBoard("https://acme.recruitee.com/o/product-designer").provider, "recruitee");
  assert.equal(detectAtsBoard("https://acme.zohorecruit.com/careers").provider, "zoho");
  assert.equal(detectAtsBoard("https://example.com/careers"), null);
});

test("builds public ATS endpoints", () => {
  assert.equal(atsEndpoint(detectAtsBoard("https://apply.workable.com/acme")), "https://apply.workable.com/api/v1/accounts/acme/jobs?details=true");
  assert.equal(atsEndpoint(detectAtsBoard("https://careers.smartrecruiters.com/acme")), "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100");
  assert.equal(atsEndpoint(detectAtsBoard("https://acme.zohorecruit.com/careers")), null);
});

test("normalizes provider job payloads", () => {
  const jobs = normalizeAtsRows({ provider: "smartrecruiters", slug: "acme" }, {
    content: [{ id: "123", name: "Product Designer", jobAd: { sections: { jobDescription: "Design systems" } }, location: { city: "Remote" }, releasedDate: "2026-11-01" }]
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Product Designer");
  assert.equal(jobs[0].jobUrl, "https://careers.smartrecruiters.com/acme/123");
});
