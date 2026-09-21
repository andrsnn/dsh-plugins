import assert from "node:assert/strict";
import test from "node:test";

import { POLICY, appliesTo, policyText } from "../lib/index.js";

test("targets the exact Flash-Next provider and model", () => {
  assert.equal(appliesTo({ agent: { options: { provider: "flash-next", model: "x" } } }), true);
  assert.equal(appliesTo({ agent: { options: { provider: "spark-hub", model: "qwen38-flash-next" } } }), true);
  assert.equal(appliesTo({ agent: { options: { provider: "rtx4090-hub", model: "rtx4090-loaded" } } }), false);
});

test("contributes no prompt text to unrelated models", () => {
  assert.equal(policyText({ agent: { options: { provider: "rtx4090-hub", model: "rtx4090-loaded" } } }), "");
  assert.equal(policyText({ agent: { options: { provider: "flash-next", model: "qwen38-flash-next" } } }), POLICY);
});
