import assert from "node:assert/strict";
import test from "node:test";

import {
  REPLACEMENT,
  apply,
  sanitizeContent,
  sanitizeText,
} from "../lib/index.js";

test("removes the exact class of llama.cpp media sentinels", () => {
  assert.equal(
    sanitizeText("before <__media_us1V7JqIl8BdBgPussVnotcZIunbguxU__> after"),
    `before ${REPLACEMENT} after`,
  );
});

test("leaves ordinary text and real media blocks unchanged", () => {
  const content = [
    { type: "text", text: "ordinary output" },
    { type: "image", data: "abc", mimeType: "image/png" },
  ];
  assert.equal(sanitizeContent(content), content);
});

test("post-execute replaces only poisoned text content", async () => {
  let listener;
  const warnings = [];
  const ctx = {
    on(event, callback, options) {
      assert.equal(event, "tools/post-execute");
      assert.deepEqual(options, { prepend: true });
      listener = callback;
    },
    logger: { warn: (message) => warnings.push(message) },
  };
  apply(ctx);

  const result = {
    isError: false,
    content: [{ type: "text", text: "{\"media_marker\":\"<__media_abc123__>\"}" }],
  };
  const decision = await listener({}, result, async () => ({ kind: "accept" }));
  assert.equal(decision.kind, "accept");
  assert.equal(decision.content[0].text, `{\"media_marker\":\"${REPLACEMENT}\"}`);
  assert.equal(warnings.length, 1);
});
