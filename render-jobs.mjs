// Builds the job-digest page into `_site/j/<token>/`.
//
// Sibling of render.mjs, same repo and same deploy: GitHub Pages replaces the whole
// site on each deployment, so the RSS digests and the job digest MUST be rendered
// into one `_site` by one workflow. Two workflows would clobber each other.
//
// Reads `Personal/private/job-search/digest.json` out of the PRIVATE
// simranjeetc/discussions repo with a read-only PAT — the same token render.mjs
// uses, which is already scoped contents:read on that repo and covers this path.
// Nothing read here is ever committed: `_site` goes straight to the Pages artifact.
//
// Same two rules as render.mjs:
//   1. Never log digest content. Run logs on a public repo are world-readable.
//   2. The path segment is the ONLY access control, so it comes from a secret.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC_OWNER = "simranjeetc";
const SRC_REPO = "discussions";
const SRC_PATH = "Personal/private/job-search/digest.json";

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

const url = `https://api.github.com/repos/${SRC_OWNER}/${SRC_REPO}/contents/${SRC_PATH}`;
const res = await fetch(url, {
  headers: {
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    accept: "application/vnd.github.raw",
  },
});

if (res.status === 404) {
  // Legitimate and expected: the job scan runs on a laptop, so it may not have
  // produced a digest yet. Skip rather than fail — this step shares a workflow
  // with the RSS deploy, and a missing job digest must not block that.
  console.log(`No ${SRC_PATH} yet — skipping the job digest, leaving the RSS deploy alone.`);
  process.exit(0);
}
if (!res.ok) {
  // Status and URL only. A 401 here usually means the PAT expired.
  throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
}

const digest = JSON.parse(await res.text());
const roles = Array.isArray(digest.roles) ? digest.roles : [];
const counts = digest.counts ?? {};

if (roles.length === 0) {
  throw new Error(`${SRC_PATH} carried no roles — refusing to publish an empty page.`);
}

// Counts only. Never the listings themselves.
console.log(
  `Rendering ${roles.length} role(s) from a digest generated ${digest.generated ?? "?"}`,
);

// The data rides in a JSON script tag and the page renders it client-side, so the
// filters work without a server. `</` is escaped so a title containing "</script>"
// cannot break out of the tag.
const payload = JSON.stringify(digest).replace(/<\//g, "<\\/");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<title>Jobs ${digest.date ?? ""}</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fdfdfc; --muted:#6b6b6b;
          --rule:#e3e3e0; --link:#0b5cad; --warn:#b06000; --chip:rgba(127,127,127,.14); }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6e6e3; --bg:#17181a; --muted:#9a9a96; --rule:#2e3033;
            --link:#7fb2f0; --warn:#e2a33c; --chip:rgba(127,127,127,.22); }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 74rem; margin: 0 auto; }
  header { border-bottom:1px solid var(--rule); padding-bottom:.6rem; margin-bottom:1rem; }
  h1 { font-size:1.05rem; font-weight:600; margin:0; }
  header p { margin:.3rem 0 0; color:var(--muted); font-size:.8rem; }
  a { color: var(--link); }
  .controls { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin:1rem 0; }
  input[type=search], select { font:inherit; font-size:.85rem; padding:.35rem .5rem;
    color:var(--fg); background:var(--bg); border:1px solid var(--rule); border-radius:6px; }
  input[type=search] { min-width:16rem; flex:1 1 16rem; }
  label.tog { font-size:.85rem; color:var(--muted); display:inline-flex; gap:.35rem; align-items:center; }
  #count { font-size:.8rem; color:var(--muted); margin-left:auto; }
  table { border-collapse:collapse; width:100%; font-size:.86rem; }
  th, td { border-bottom:1px solid var(--rule); padding:.4rem .5rem; text-align:left; vertical-align:top; }
  th { position:sticky; top:0; background:var(--bg); font-weight:600; font-size:.78rem;
       text-transform:uppercase; letter-spacing:.03em; color:var(--muted); z-index:1; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.role { min-width:18rem; }
  .muted { color: var(--muted); }
  .chip { background:var(--chip); border-radius:4px; padding:.05rem .35rem; font-size:.72rem;
          color:var(--muted); white-space:nowrap; }
  .chip.warn { color: var(--warn); font-weight:600; }
  .chip.direct { color: #137333; }
  @media (prefers-color-scheme: dark) { .chip.direct { color:#6fd08c; } }
  nav { margin-top:2rem; padding-top:.75rem; border-top:1px solid var(--rule);
        font-size:.78rem; color:var(--muted); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Job digest${digest.date ? " &middot; " + digest.date : ""}</h1>
    <p id="summary"></p>
  </header>
  <div class="controls">
    <input id="q" type="search" placeholder="filter title, company, location, board…">
    <select id="board"><option value="">all boards</option></select>
    <select id="sort">
      <option value="score">sort: score</option>
      <option value="age">sort: posting age</option>
      <option value="seen">sort: newest found</option>
      <option value="company">sort: company</option>
    </select>
    <label class="tog"><input type="checkbox" id="verify"> only verify</label>
    <span id="count"></span>
  </div>
  <table>
    <thead><tr>
      <th class="num">#</th><th class="num">Score</th><th class="num">Age</th>
      <th>Role</th><th>Company</th><th>Location</th><th>Comp</th><th>Board</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <nav id="foot"></nav>
</main>
<script id="digest" type="application/json">${payload}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById("digest").textContent);
  var all = d.roles || [], c = d.counts || {};
  var esc = function (s) { return (s == null ? "" : String(s)); };

  document.getElementById("summary").textContent =
    all.length + " roles" +
    (c.verify ? " \\u00b7 " + c.verify + " to verify" : "") +
    (c.direct ? " \\u00b7 " + c.direct + " direct-apply" : "") +
    (c.dropped_old ? " \\u00b7 " + c.dropped_old + " dropped as older than " +
      (d.settings && d.settings.max_age_days) + "d" : "") +
    (c.undated ? " \\u00b7 " + c.undated + " publish no date" : "") +
    " \\u00b7 generated " + esc(d.generated);

  var boards = {};
  all.forEach(function (r) { if (r.board) boards[r.board] = (boards[r.board] || 0) + 1; });
  var bsel = document.getElementById("board");
  Object.keys(boards).sort(function (a, b) { return boards[b] - boards[a]; })
    .forEach(function (b) {
      var o = document.createElement("option");
      o.value = b; o.textContent = b + " (" + boards[b] + ")";
      bsel.appendChild(o);
    });

  var tbody = document.getElementById("rows");
  function render() {
    var q = document.getElementById("q").value.trim().toLowerCase();
    var board = bsel.value;
    var onlyV = document.getElementById("verify").checked;
    var sort = document.getElementById("sort").value;

    var rows = all.filter(function (r) {
      if (board && r.board !== board) return false;
      if (onlyV && !r.verify) return false;
      if (!q) return true;
      return (r.title + " " + r.company + " " + r.location + " " + r.board)
        .toLowerCase().indexOf(q) >= 0;
    });

    rows.sort(function (a, b) {
      if (sort === "score") return (b.score - a.score) || (a.title < b.title ? -1 : 1);
      if (sort === "company") return (a.company || "").localeCompare(b.company || "");
      if (sort === "seen") return (b.first_seen || "").localeCompare(a.first_seen || "")
        || (b.score - a.score);
      // age: youngest posting first; unknown age always last
      var an = (a.age === null || a.age === undefined) ? Infinity : a.age;
      var bn = (b.age === null || b.age === undefined) ? Infinity : b.age;
      return (an - bn) || (b.score - a.score);
    });

    var out = [];
    rows.forEach(function (r, i) {
      var chips = "";
      if (r.verify) chips += ' <span class="chip warn" title="names a hub city beside a remote flag \\u2014 verify the remote scope">verify</span>';
      var link = r.url
        ? '<a href="' + encodeURI(r.url) + '" target="_blank" rel="noopener">' + esc(r.title) + "</a>"
        : esc(r.title);
      out.push("<tr>"
        + '<td class="num muted">' + (i + 1) + "</td>"
        + '<td class="num">' + (r.score || 0) + "</td>"
        + '<td class="num muted">' + (r.age === null || r.age === undefined ? "\\u2014" : r.age + "d") + "</td>"
        + '<td class="role">' + link + chips + "</td>"
        + "<td>" + esc(r.company) + "</td>"
        + '<td class="muted">' + esc(r.location) + "</td>"
        + '<td class="num">' + esc(r.comp) + "</td>"
        + '<td class="muted">' + esc(r.board) + "</td>"
        + "</tr>");
    });
    tbody.innerHTML = out.join("") || '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>';
    document.getElementById("count").textContent = rows.length + " of " + all.length;
  }

  ["q", "board", "sort", "verify"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener(id === "q" ? "input" : "change", render);
  });
  render();

  document.getElementById("foot").textContent =
    "Read-only mirror of the private job scan. Age is the employer's posting date where "
    + "the board publishes one; the list is ordered by when the scan first saw it.";
})();
</script>
</body>
</html>
`;

const outDir = join("_site", "j", pathToken);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), html, "utf8");

// Note the absence of a site-root index.html, same as render.mjs:
// simranjeetc.github.io/digest-mirror/ serves Pages' 404 and Pages does not list
// directories, so the path segment is the only way in.
console.log("Wrote _site/j/<token>/index.html");
