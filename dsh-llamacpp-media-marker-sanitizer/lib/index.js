const name = "llamacpp-media-marker-sanitizer";
const inject = ["tools"];

// llama.cpp publishes a per-process sentinel through GET /props. If that
// literal is replayed as prompt text, the multimodal tokenizer treats it as an
// attachment placeholder and rejects the request when no media object exists.
const MEDIA_MARKER_PATTERN = /<__media_[A-Za-z0-9_-]+__>/g;
const REPLACEMENT = "[llama.cpp media placeholder removed]";

function sanitizeText(text) {
  if (typeof text !== "string" || !text.includes("<__media_")) return text;
  return text.replace(MEDIA_MARKER_PATTERN, REPLACEMENT);
}

function sanitizeContent(content) {
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = sanitizeText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? next : content;
}

function apply(ctx) {
  ctx.on("tools/post-execute", async (_exec, result, next) => {
    const decision = await next();
    if (decision.kind !== "accept" || Object.hasOwn(decision, "value")) {
      return decision;
    }
    const original = decision.content ?? result.content;
    const content = sanitizeContent(original);
    if (content === original) return decision;
    ctx.logger.warn("removed a literal llama.cpp media placeholder from tool output");
    return {
      kind: "accept",
      content,
      ...(decision.additionalContexts
        ? { additionalContexts: decision.additionalContexts }
        : {}),
    };
  }, { prepend: true });

  console.log("[llamacpp-media-marker-sanitizer] armed");
}

export {
  MEDIA_MARKER_PATTERN,
  REPLACEMENT,
  apply,
  inject,
  name,
  sanitizeContent,
  sanitizeText,
};
