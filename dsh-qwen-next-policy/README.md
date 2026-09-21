# dsh-qwen-next-policy

Adds a model-scoped system-prompt section for Qwen3.8 Flash-Next. It keeps
Medium reasoning useful while discouraging unnecessary planning, todo, and
verification rounds on bounded tasks. It does not disable thinking and emits
no prompt text for unrelated providers/models.

Run `npm test` to verify model scoping.
