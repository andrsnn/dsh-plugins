# dsh-plan-file

The document you are working on is a file you can watch: model-facing
`doc_read` / `doc_write` / `doc_edit` tools, a read-only route the browser
polls, and a live markdown panel docked beside the chat.

Two modes use it:

- **plan mode** — DSH's own mode. The document is `PLAN.md`, and the end of it
  is an approved plan that gets implemented.
- **refine mode** — this plugin's mode, entered with `/refine <file.md>`. The
  document is whatever the conversation is about, and there is no
  implementation step at all: the deliverable IS the file.

## Why

DSH ships plan mode (`@deepseek-ai/dsh-plan-mode`), but the plan lives in the
model's context until `exit_plan_mode` presents the whole thing at once. Two
things follow, and both hurt an iterative review:

- **Changing one step costs a full re-emission.** "Make step 3 use the existing
  cache" means the model rewrites the entire plan, which is slow on a local
  model and loses your place in it.
- **Between turns there is nothing to look at.** The plan only becomes visible
  at the moment it is being approved.

This plugin gives the plan a file. `doc_write` lays down the first draft,
`doc_edit` patches it by exact string replacement afterwards, and the panel
renders what is on disk while you keep talking.

## What it adds

| surface | behavior |
|---|---|
| `doc_read` | Returns the session's document plus its checklist progress. Authoritative after a compaction, a resume, or a hand edit. |
| `doc_write` | Creates or replaces it. Meant to be called **once**, for the first draft. |
| `doc_edit` | Ordered `{old_str, new_str, replace_all?}` replacements. An empty `old_str` appends. A miss or an ambiguous match is refused rather than guessed at. |
| `/refine [off\|<file.md>] [message]` | Enters refine mode on a document, creating it if needed, and steers the rest of the line as an ordinary message. `/refine off` leaves; the target survives so `/refine` resumes where it left off. |
| composer strip | One line above the composer: file name, a `refine` tag when refining, `4/9 steps`, when it last changed, a **GO** button (plan mode only) that drafts "GO - implement the plan in PLAN.md.", and show/hide. |
| docked panel | Right-hand panel rendering the markdown, resizable by dragging its left edge, with newly-changed blocks flashing once. The app frame narrows to match, so the panel sits beside the chat rather than over it. |

There is no document picker, by design: all three tools take an optional `file`,
and passing it both targets that call **and** moves the session — so "refine
gamma-deck.md" or "start a doc on the rollout risks" switches the panel through
ordinary conversation, with no extra tool in the catalog.

The panel opens when either mode is on **or** the file exists, so it is visible
during the exploration that precedes the first write. Plan-mode state is read
from the `plan` session projection; a composition without one (the `minimal`
preset mounts no plan mode) reports off instead of failing.

The panel is deliberately read-only. The document is edited by talking to the
model, which is the entire point of keeping it in a file the model can patch.

## Where the file goes

In the **session workspace**, resolved from the live (or restored) Session's
`cwd`. A caller names a workspace-relative markdown file at most — absolute
paths, `..`, and non-markdown names are refused — so neither the model nor the
browser can put the document outside the workspace it belongs to.
Subdirectories (`notes/strategy.md`) are fine and are created on write; writes
are atomic, so the browser's poll never catches a half-written file.

Which document a session is on (and whether it is refining) is durable, kept in
`$DSH_HOME/storages/plan-file-sessions.json` rather than in the workspace, so a
`dsh web` restart mid-review does not silently drop every session back to
`PLAN.md` and nothing appears in anyone's `git status`.

## The prompt half

The tools alone are not enough: the stock plan-mode section tells the model
"Do not edit or write files", which would forbid the one write this design
needs. That section is configured from each shipped agent preset
(`config/agent-presets/*/agent.cordis.yml`), not from a profile patch layer —
the host-plane row is disabled by `dsh-web-app`, so a profile patch cannot
address it.

`../patch_plan_file_prompt.py` rewrites it, keeping every other restriction and
adding the PLAN.md discipline (draft once, edit after, do not restate the plan
in chat, tick `- [ ]` to `- [x]` during implementation). It is version-locked,
idempotent, keeps one backup per file, and `--restore` puts the stock text
back. All three installers run it.

Refine mode's own guidance needs no vendor patch, because this plugin owns it.
It is contributed as one section whose entire text is a `{{variable}}`: a
section is a fixed string, but a variable is resolved per assembly with that
assembly's agent, which is what makes the guidance per-session instead of a
global flag. A session that is not refining resolves it to the empty string,
the section is dropped, and it costs zero tokens.

## Install

The installers do this from the committed profile manifests — on Windows
`.\start.ps1 setup-dsh`, on macOS `scripts/setup-deepseek-mac.sh`, on Linux
`bash integrations/dsh/setup_spark.sh`. By hand:

```bash
cp -r integrations/dsh/dsh-plan-file ~/.dsh/plugins/
pnpm --dir ~/.dsh/profiles/web install --ignore-scripts
python integrations/dsh/patch_plan_file_prompt.py
```

The package declares `dsh.bundle.patch`, so its row composes automatically once
it is listed in the profile manifest's `dsh.profile.bundles`; no manual
`- insert:` row is needed. Restart `dsh web` — DSH loads plugin JavaScript only
at process start.

Verify:

```bash
dsh --profile web --dump-config | grep -A3 'id: plan-file'
curl -s http://127.0.0.1:3080/plugin/plan-file/state/nope   # {"error":"the session has no live workspace"}
```

## Config

| key | default | meaning |
|---|---|---|
| `fileName` | `PLAN.md` | The default document, and the one plan mode uses. Must be one file name, not a path. |
| `maxBytes` | `524288` | Refuse a document larger than this. These are review artifacts; past a few hundred KB something is writing logs into one. |

## Tests

```bash
cd integrations/dsh/dsh-plan-file
node --test "tests/*.spec.mjs"   # 38/38, no DSH runtime and no DOM needed
```

The host suite covers name normalization and path containment, the
missing-file state, atomic writes, the edit semantics (unique match,
`replace_all`, append, sequential edits), the size cap, both routes' URL
parsing, per-session targeting, `/refine` parsing and dispatch (including a
steer that throws), and the three tools end to end against a temp workspace. It
points `DSH_HOME` at a throwaway directory, so it never touches the real
harness home. The client suite stands up a stub module loader and React to
exercise the markdown parser, the stores, and the plan-mode projection read.
