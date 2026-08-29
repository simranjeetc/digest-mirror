// Builds `_site/` for the digest mirror.
//
// Reads the last few digest notes out of the PRIVATE simranjeetc/discussions
// repo with a read-only PAT, renders them to HTML, and writes them under an
// unguessable path segment. Nothing read here is ever committed: the output
// directory is handed straight to actions/upload-pages-artifact.
//
// Two rules this file exists to enforce:
//   1. Never log digest content. Run logs on a public repo are world-readable.
//   2. The path segment is the ONLY access control on the published site, so
//      it comes from a secret and never from anything committed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC_OWNER = "simranjeetc";
const SRC_REPO = "discussions";
const SRC_DIR = "Personal/private/rss-content-automation/digests";

// A rolling window costs nothing and covers a morning the digest missed.
const KEEP = 5;

const token = process.env.DIGEST_SOURCE_TOKEN;
const pathToken = process.env.DIGEST_PATH_TOKEN;

if (!token) {
  throw new Error("DIGEST_SOURCE_TOKEN is not set. Add it as a repository secret.");
}
if (!/^[0-9a-f]{12,}$/.test(pathToken ?? "")) {
  throw new Error(
    "DIGEST_PATH_TOKEN is missing or not a long hex string. Generate one with `openssl rand -hex 8`.",
  );
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!res.ok) {
    // Deliberately reports status and URL only. A 401 here almost always means
    // the PAT expired — fine-grained tokens do, silently, and this is the
    // first place that becomes visible.
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  }
  return res;
}

const contentsUrl = (path) =>
  `https://api.github.com/repos/${SRC_OWNER}/${SRC_REPO}/contents/${path}`;

// Pick the newest digests by listing rather than by constructing today's date.
// Self-healing: a late or skipped run still publishes whatever is actually
// there, so a catch-up run needs no special casing.
const listing = await (await api(contentsUrl(SRC_DIR))).json();
const names = listing
  .filter((e) => e.type === "file" && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
  .map((e) => e.name)
  .sort()
  .reverse()
  .slice(0, KEEP);

if (names.length === 0) {
  throw new Error(`No digest notes matched YYYY-MM-DD.md under ${SRC_DIR}`);
}

console.log(`Publishing ${names.length} digest(s): ${names.join(", ")}`);

async function renderMarkdown(markdown) {
  const res = await api("https://api.github.com/markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: markdown, mode: "markdown" }),
  });
  return res.text();
}

const dates = names.map((n) => n.replace(/\.md$/, ""));

function page(date, bodyHtml) {
  const others = dates
    .filter((d) => d !== date)
    .map((d) => `<a href="./${d}.html">${d}</a>`)
    .join("\n      ");

  // `noindex` in a meta tag is the real crawl control here. A project Pages
  // site cannot serve an effective robots.txt — crawlers only honour one at
  // the domain root (simranjeetc.github.io/robots.txt), which belongs to a
  // user-site repo, not to this one. Pages also allows no custom response
  // headers, so X-Robots-Tag is unavailable. Hence: HTML, with this tag.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<title>Digest ${date}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fdfdfc; --muted: #6b6b6b; --rule: #e3e3e0; --link: #0b5cad; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6e6e3; --bg: #17181a; --muted: #9a9a96; --rule: #2e3033; --link: #7fb2f0; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 5rem; background: var(--bg); color: var(--fg);
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  header { border-bottom: 1px solid var(--rule); padding-bottom: .75rem; margin-bottom: 2rem; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0; letter-spacing: .01em; }
  header p { margin: .35rem 0 0; color: var(--muted); font-size: .8rem; }
  a { color: var(--link); }
  h2 { font-size: 1.25rem; margin-top: 2.25rem; }
  h3 { font-size: 1.05rem; margin-top: 1.75rem; }
  img { max-width: 100%; }
  pre { overflow-x: auto; padding: .75rem; background: rgba(127,127,127,.12); border-radius: 6px; }
  code { font-size: .9em; }
  table { border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--rule); padding: .4rem .6rem; text-align: left; }
  blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--muted); }
  nav { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: .85rem; }
  nav a { margin-right: 1rem; white-space: nowrap; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Digest &middot; ${date}</h1>
    <p>Read-only mirror. Selection stays in the source issue.</p>
  </header>
  ${bodyHtml}
  <nav>
      ${others || "<span>No earlier days in the window.</span>"}
  </nav>
</main>
</body>
</html>
`;
}

const outRoot = join("_site", "d", pathToken);

for (const [i, name] of names.entries()) {
  const date = dates[i];
  const markdown = await (
    await api(contentsUrl(`${SRC_DIR}/${name}`), {
      headers: { accept: "application/vnd.github.raw" },
    })
  ).text();

  const html = page(date, await renderMarkdown(markdown));

  // Newest also lands on index.html so the bookmarked URL never changes.
  const targets = [join(outRoot, `${date}.html`)];
  if (i === 0) targets.push(join(outRoot, "index.html"));

  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html, "utf8");
  }
}

// Note the absence of a site-root index.html. simranjeetc.github.io/digest-mirror/
// serves Pages' 404, and Pages does not list directories, so the path segment
// is genuinely the only way in.
console.log("Wrote _site. Newest digest is at d/<token>/index.html");
