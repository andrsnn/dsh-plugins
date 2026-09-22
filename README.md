<div align="center">

# dsh-plugins

**Twelve plugins for the DeepSeek Harness (`dsh`).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Plugins](https://img.shields.io/badge/plugins-12-brightgreen)
![dsh](https://img.shields.io/badge/dsh-0.1.1--rc.2-orange)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933)

</div>

---

`dsh` is the client and agent runtime that talks to an OpenAI-compatible model
backend, such as a local llama.cpp or vLLM server. Each plugin here is a
separate MIT-licensed package you install into a `dsh` **profile**. They do not
depend on each other, so install only the ones you want.

Everything was built and run against `dsh` `0.1.1-rc.2`. A later build may move
the seam a plugin hooks, so read that plugin's own README before you upgrade.

## Plugins

### Keep an unattended run going

| Plugin | What it does |
|---|---|
| [`dsh-goal-auto-resume`](dsh-goal-auto-resume/) | Resumes a goal that paused because the **model** failed (backend reload, transport reset, a turn-0 error). It waits until the backend reports ready, then resumes. It never resumes a goal a person paused. Uses exponential backoff and an attempt cap so a dead backend cannot loop. |
| [`dsh-auto-continue`](dsh-auto-continue/) | Handles the other stall: a turn that ends cleanly at the output token cap (`max-tokens`). It re-arms an active goal, or sends "continue" for a plain turn. A cap on consecutive stalls stops it looping forever. |

### Control the backend

| Plugin | What it does |
|---|---|
| [`dsh-global-queue`](dsh-global-queue/) | FIFO admission control at the `llm/stream` boundary. Every chat and child agent submits right away, but only N response streams (default 2) reach each backend at once. You can group aliases so they share one allowance. Queued calls stay cancellable. |
| [`dsh-qwen-next-policy`](dsh-qwen-next-policy/) | A system-prompt section aimed at one exact model id (a Qwen Flash-Next). It keeps thinking on but tells the model to skip busywork on small tasks and stop once the outcome is proven. It sends nothing for any other model. |
| [`dsh-llamacpp-media-marker-sanitizer`](dsh-llamacpp-media-marker-sanitizer/) | llama.cpp `GET /props` exposes a private `<__media_...__>` sentinel. Replaying that string as tool output makes the next request fail to tokenize. This plugin replaces only literal sentinels in text tool results and leaves native media blocks alone. |

### Images and web

| Plugin | What it does |
|---|---|
| [`dsh-image-finder`](dsh-image-finder/) | Two model-facing tools: `find_images` (Brave Image Search API when a key is set, otherwise keyless Bing HTML scraping plus og:image/JSON-LD page scraping) and `fetch_image` (one URL). Downloads are magic-byte-checked images saved in the session workspace, so `read_image` can open them. |
| [`dsh-image-inline`](dsh-image-inline/) | A model-facing `show_image(path)` that renders a click-to-load preview **inside the web chat**. The tool result is text only; image bytes go through the plugin's own loopback route, so the picture never enters model context. Vendored from [condaThinker/dsh-image-inline](https://github.com/condaThinker/dsh-image-inline) (MIT). |
| [`dsh-web-search-ollama`](dsh-web-search-ollama/) | A `ctx.web` search provider. It queries Ollama Cloud web search first and falls back to the Brave Search API. It registers as `ollama-brave`; point the web seam's `searchProvider` at that id. |
| [`dsh-file-shuttle`](dsh-file-shuttle/) | Two model-facing tools: `send_files` publishes files or folders (several are zipped) through one background server on port 8931 and returns expiring download links for the tailnet, the LAN, and loopback. `shuttle_status` lists and purges links. Originals are copied to an outbox, never served in place. |

### Web UI

| Plugin | What it does |
|---|---|
| [`dsh-chat-attachments`](dsh-chat-attachments/) | Adds a composer paperclip on older web builds. Images use DSH's native image-draft pipeline. Other files are content-addressed into the workspace, and their paths are appended to the draft so the agent's filesystem tools can read them. |
| [`dsh-compact-layout`](dsh-compact-layout/) | A display control in the frame overlay: a focus layout that hides the rails (good on phones), a text scale remembered between 80% and 120%, and a full-screen button. It uses only the additive `shell.overlay` slot. |
| [`dsh-plan-file`](dsh-plan-file/) | Turns the plan or working document into a real file you can watch. It adds `plan_read`/`plan_write`/`plan_edit` (and `doc_*` / `/refine`) against a markdown file in the workspace, a live right-hand panel, and a `steps` strip with a GO button. |

## Install

A plugin installs into a `dsh` **profile**, not into the `@deepseek-ai/dsh`
package. `$DSH_HOME` defaults to `~/.dsh`.

**1. Copy the plugin somewhere stable** the harness can link. Avoid paths with
spaces; dsh's `shell:true` pnpm spawn can fail on them.

```bash
mkdir -p ~/.dsh/plugins
cp -r dsh-global-queue ~/.dsh/plugins/
```

**2. Link it into your profile** (here, `web`). This is a pnpm link, so pass the
directory.

```bash
dsh plugin --profile web add -w ~/.dsh/plugins/dsh-global-queue
```

**3. Turn it on** in that profile's `cordis.patch.yml`. A *new* plugin row must
be wrapped in `- insert:`; a bare `- id:` only addresses a row a bundle already
declared. Several plugins ship a ready `cordis.patch.yml` to copy the row from.

```yaml
- insert:
    - id: global-queue
      name: dsh-global-queue
      config:
        concurrency: 2
        queueGroups:
          backend-a: [alias-1]
          backend-b: [alias-2, alias-3]
```

`dsh-image-inline` declares `dsh.bundle.patch`, so its `add` composes the row
for you. No manual insert is needed for that one.

**4. Verify** the row composed and the plugin armed on boot.

```bash
dsh --profile web --dump-config | grep -A3 'id: global-queue'
# start dsh web and look for a boot line like: [global-queue] armed {...}
```

If `--dump-config` does not show the row, the `- insert:` wrapper is missing. If
it shows but the log never prints `armed`, the `dsh plugin add` link did not take.

## Tests

Every plugin runs its tests without a live `dsh` runtime. They mock the harness.

```bash
node dsh-goal-auto-resume/test.mjs
node dsh-auto-continue/test.mjs
node dsh-image-finder/test.mjs                 # add --live for 2 real network tests
cd dsh-global-queue && npm test
cd dsh-qwen-next-policy && npm test
cd dsh-llamacpp-media-marker-sanitizer && npm test
node --test dsh-plan-file/tests/*.spec.mjs
node --test dsh-image-inline/tests/*.spec.mjs  # the render suite needs react@18 + react-dom@18 via DSH_HARNESS_NODE_MODULES
```

## Configuration and secrets

- This repo commits no secrets. The plugins that need an API key
  (`dsh-image-finder`, `dsh-web-search-ollama`) read `BRAVE_API_KEY` and Ollama
  credentials from the environment or `~/.dsh/.env` at runtime. The source never
  contains them.
- This repo has no backend addresses, home paths, or machine-specific routing.
  Those live in your own profile's `cordis.patch.yml`. Point health and base
  URLs at whatever your Hub binds: loopback on the same box, the LAN address
  from another.

## License

MIT. See [LICENSE](LICENSE). `dsh-image-inline/` is vendored from an upstream
MIT project; see its README for attribution.
