# dsh-image-finder

Model-facing image tools for the DeepSeek Harness: **`find_images`** (web image
search + page scraping + local download) and **`fetch_image`** (direct URL
download). Downloads land in the session workspace so the agent can view them
with the built-in `read_image` tool.

## Why

The sandboxed shell tools (`pwsh`/`bash`) run under a file sandbox that can
block outbound HTTPS (observed: port 443 denied, port 80 allowed), so "find me
images" was impossible from an agent turn. This plugin runs inside the harness
process with normal network access and does the fetching there.

## Backends (in order)

1. **Brave Image Search API** (`/res/v1/images/search`, safesearch strict) when
   `BRAVE_API_KEY` is configured. Key resolution order: literal plugin config
   -> `process.env` -> `~/.dsh/.env` (same convention as `dsh-web-search-ollama`).
2. **Bing HTML scraping** (`/images/search`, keyless) - primary when no key,
   fallback when Brave errors. Tried over https first, retried over plain http
   so it also works from networks that block outbound 443.
3. **Page scraping** for any `urls` the model already has: `og:image` (and
   `og:image:secure_url`), `twitter:image`, `link[rel=image_src]`, JSON-LD
   `image` fields, and `<img src>` (relative refs resolve post-redirect;
   `data:` URIs and SVG are dropped).

Every download is verified as a real image (content-type + magic bytes,
jpeg/png/gif/webp, 10 MiB cap) so an HTML error page is never saved as a photo.

## Tools

| tool | args | returns |
|---|---|---|
| `find_images` | `query`, `urls?`, `maxImages?` (cap 32), `download?` (default true) | candidate list with `localPath` per image, download count, per-source failures |
| `fetch_image` | `url`, `destName?` | `localPath`, `contentType`, `bytes` |

Files are written to `<outDir>/<query-slug>/<name>` (default
`outDir = <harness cwd>/images` - the session workspace - so `read_image` can
open them directly).

## Test (no dsh runtime needed)

```bash
node integrations/dsh/dsh-image-finder/test.mjs          # 9/9 offline (mocked fetch)
node integrations/dsh/dsh-image-finder/test.mjs --live   # + 2 live Bing tests (plain http)
```

## Install (once, after dsh itself is installed)

Same out-of-tree pattern as the other llmhub plugins:

```powershell
# 1. copy where dsh can link it
Copy-Item -Recurse integrations\dsh\dsh-image-finder "$env:USERPROFILE\.dsh\plugins\"

# 2. link into the web profile (pnpm)
dsh plugin --profile web add "$env:USERPROFILE\.dsh\plugins\dsh-image-finder"

# 3. enable in the profile patch layer (new rows must be `insert`ed)
```

Add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: image-finder
      name: dsh-image-finder
      config:
        braveApiKeyEnv: BRAVE_API_KEY   # resolved from ~/.dsh/.env
        # outDir: ""                    # empty => <harness cwd>/images
        maxImages: 8
```

Verify: `dsh --profile web --dump-config | findstr /C:"image-finder"`, then
**restart `dsh web`** - plugins load at process start. The boot log line is:

```
[image-finder] armed (braveKey=yes, outDir=..., maxImages=8)
```

## Config

| key | default | meaning |
|---|---|---|
| `braveApiKeyEnv` | `BRAVE_API_KEY` | env name (config literal also accepted). No key => Bing only. |
| `outDir` | `<cwd>/images` | root directory for downloads. |
| `maxImages` | `8` | default cap for `find_images`. |
| `timeoutMs` | `20000` | per-HTTP-request timeout. |
| `maxDownloadBytes` | `10485760` | refuse larger images. |
