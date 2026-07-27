import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("gateway exposes matching add and remove workflow routes", () => {
  assert.match(source, /app\.post\("\/ghl\/contacts\/:id\/workflow\/:workflowId"/);
  assert.match(source, /app\.delete\("\/ghl\/contacts\/:id\/workflow\/:workflowId"/);
});

test("workflow enrollment always sends an America/Chicago offset eventStartTime", () => {
  assert.match(source, /function chicagoIsoOffset/);
  assert.match(source, /timeZone: "America\/Chicago"/);
  assert.match(source, /eventStartTime = req\.body\?\.eventStartTime \|\| chicagoIsoOffset\(\)/);
  assert.match(source, /ghlFetch\([\s\S]*"POST",[\s\S]*`\/contacts\/\$\{req\.params\.id\}\/workflow\/\$\{req\.params\.workflowId\}`,[\s\S]*\{ eventStartTime \}/);
});

test("gateway release identifies deterministic-enrollment build", () => {
  assert.match(source, /version: "7\.2\.2"/);
  assert.match(source, /POST   \/ghl\/contacts\/:id\/workflow\/:workflowId/);
});
