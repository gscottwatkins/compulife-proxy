import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("gateway exposes matching add and remove workflow routes", () => {
  assert.match(source, /app\.post\("\/ghl\/contacts\/:id\/workflow\/:workflowId"/);
  assert.match(source, /app\.delete\("\/ghl\/contacts\/:id\/workflow\/:workflowId"/);
});

test("workflow enrollment uses the v3 immediate-enrollment request without legacy scheduling fields", () => {
  assert.match(source, /ghlFetch\([\s\S]*"POST",[\s\S]*`\/contacts\/\$\{req\.params\.id\}\/workflow\/\$\{req\.params\.workflowId\}`[\s\S]*\)/);
  assert.doesNotMatch(source, /eventStartTime/);
});

test("gateway release identifies deterministic-enrollment build", () => {
  assert.match(source, /version: "7\.2\.3"/);
  assert.match(source, /POST   \/ghl\/contacts\/:id\/workflow\/:workflowId/);
});
