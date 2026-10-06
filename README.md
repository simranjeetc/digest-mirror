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

  job scan, 09:15 IST (laptop)          same workflow, same deploy
  commits digest.json                   fetches it via the same PAT
                                        renders a filterable table
                                              |
                        simranjeetc.github.io/digest-mirror/j/<token>/
```

Pull, never push. Handing the digest over from the private repo in a
`repository_dispatch` payload would place it in this repo's publicly readable
event payload, which would defeat the whole design.

Both digests **must** ride in one workflow. `deploy-pages` replaces the entire
site from a single artifact, so a second workflow deploying here would clobber
whichever ran first — `concurrency: group: pages` serialises the deploys but
does not merge them. The two renderers write into the same `_site` before one
upload.

## The job digest

`render-jobs.mjs` renders `Personal/private/job-search/digest.json` — a
machine-readable feed the laptop-side scan writes — into `/j/<token>/`. Keeping
the source JSON rather than markdown means this repo needs no markdown parser
and no regex over a table that can gain columns.

It reuses `DIGEST_SOURCE_TOKEN` (already `contents:read` on `discussions`, so it
covers that path) and `DIGEST_PATH_TOKEN`.

Two deliberate choices:

- **The step is `continue-on-error`.** The job scan runs on a laptop, so its
  digest can legitimately be absent or stop updating. That must not take the RSS
  deploy down with it. A real failure still appears in the run log, and the page
  carries its own `generated` timestamp so staleness is visible where it matters.
- **The published data is listings only** — score, title, company, location,
  comp, board, URL. No notes, no statuses, nothing from the tracker. The score is
  the same public-listing heuristic the email uses.

The page sorts and filters client-side (score, posting age, board, verify flag,
free text), which is the thing that made it worth publishing rather than mailing
— at a few hundred roles the HTML email exceeded Gmail's ~102 KB render limit
and was clipped.

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
