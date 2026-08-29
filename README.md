# digest-mirror

Publishes the last few daily RSS digests to GitHub Pages so they can be read
from a work machine that cannot hold a GitHub session and cannot reach
`gist.github.com`.

The digests themselves live in the private `simranjeetc/discussions` repo and
**are never committed here**. This repository contains only the workflow and
the renderer; the content is fetched at runtime and passed directly to the
Pages artifact.

## How it works

```
private discussions repo              this repo (public)
  daily-digest, 01:30 UTC               publish, 03:00 UTC (+08:00 catch-up)
  commits the vault note                fetches the newest digests via PAT
                                        renders HTML with <meta noindex>
                                        upload-pages-artifact -> deploy-pages
                                              |
                        simranjeetc.github.io/digest-mirror/d/<token>/
```

Pull, never push. Handing the digest over from the private repo in a
`repository_dispatch` payload would place it in this repo's publicly readable
event payload, which would defeat the whole design.

## What protects it

The path segment is the only access control. It comes from a repository secret
and appears in no committed file. Pages serves no directory listing and there
is no site-root `index.html`, so `/digest-mirror/` returns a 404.

Crawling is blocked by `<meta name="robots" content="noindex, ...">` in each
rendered page. A **project** Pages site cannot use `robots.txt` for this —
crawlers honour one only at the domain root, `simranjeetc.github.io/robots.txt`,
which is served by a user-site repository rather than this one. Pages allows no
custom response headers either, so `X-Robots-Tag` is unavailable. The meta tag
is the enforceable control, which is why the digest is rendered to HTML rather
than served as raw markdown.

This is obscurity, not access control. Anyone holding the URL can read it. That
is an accepted trade: the digest is a list of public articles, and the private
critique pass is already stripped upstream by `persistCritique` in the source
pipeline.

## Required secrets

| Secret | What it is |
|---|---|
| `DIGEST_SOURCE_TOKEN` | Fine-grained PAT, resource owner `simranjeetc`, **only** the `discussions` repository, **Contents: Read-only**. Nothing else. |
| `DIGEST_PATH_TOKEN` | Long hex string from `openssl rand -hex 8`. Generate it locally and paste it straight into the secret field. |

`DIGEST_SOURCE_TOKEN` expires. When it does, the workflow fails with a
`GitHub API 401` from `render.mjs` rather than publishing something stale.

## Settings

Settings → Pages → Build and deployment → **Source: GitHub Actions**.
Do not switch this to "Deploy from a branch".
