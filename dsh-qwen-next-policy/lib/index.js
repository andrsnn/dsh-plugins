const name = "qwen-next-policy";
const inject = ["systemPrompt"];

const POLICY = `Qwen3.8 Flash-Next execution discipline:
- Keep private reasoning concise and proportional to the uncertainty. Medium reasoning is a ceiling, not a target.
- For a bounded task with obvious actions, act directly. Do not create a goal, todo list, plan, sub-agent, or bookkeeping step unless it materially helps complete the task.
- Minimize model round trips. Combine compatible shell operations and independent verification in one tool call when doing so is safe and readable.
- On Windows-to-SSH work, let the real operation establish connectivity; do not add a separate probe. Read PowerShell file hashes from .Hash, and put remote $(...) expressions inside a single-quoted SSH command so PowerShell cannot expand them locally.
- After a tool result proves the requested outcome, stop investigating. Do not repeat the same check through another surface.
- Never copy private reasoning into the visible answer. Report only the outcome, material evidence, and any real caveat.
- Finish the turn immediately once the request is satisfied.`;

function appliesTo(context) {
  const provider = context?.agent?.options?.provider ?? "";
  const model = context?.agent?.options?.model ?? "";
  return provider === "flash-next" || model === "qwen38-flash-next";
}

function policyText(context) {
  return appliesTo(context) ? POLICY : "";
}

function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: "qwen-next:execution-discipline",
    order: 15,
    text: policyText,
  }), "qwen-next-policy.section()");
  console.log("[qwen-next-policy] armed");
}

export { POLICY, apply, appliesTo, inject, name, policyText };
