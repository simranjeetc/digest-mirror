// Tests for render-jobs.mjs — the job-digest page builder.
//
//   node test-render-jobs.mjs            # synthetic fixtures, no network
//   node test-render-jobs.mjs digest.json   # also run against a real digest
//
// Runs the real renderer with a stubbed fetch and a minimal DOM, then drives the page's
// own inline script: the source/board filters, the AND between them, the free-text box,
// and the "older digest has no found_via" fallback. Exits non-zero on any failure.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(here, "render-jobs.mjs");
const fails = [];
const check = (name, cond, detail = "") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "   <-- " + detail));
  if (!cond) fails.push(name);
};

function role(i, over = {}) {
  return {
    score: 20 - i, posted: "2026-10-15", age: 3, title: "Role " + i,
    company: "Co " + i, location: "Remote", comp: "", board: i % 2 ? "ashby" : "linkedin",
    found_via: i % 2 ? "CareerHound" : "HiringCafe",
    found_section: (i % 2 ? "CareerHound" : "HiringCafe") + " — backend",
    url: "https://example.test/" + i, alt_urls: [], verify: false,
    first_seen: "2026-10-18", ...over,
  };
}

// Render one digest and return { html, els, digest } after the page's script has run.
async function render(digest) {
  const raw = JSON.stringify(digest);
  globalThis.fetch = async () => ({
    status: 200, ok: true, statusText: "OK", text: async () => raw,
  });
  process.env.DIGEST_SOURCE_TOKEN = "stub";
  process.env.DIGEST_PATH_TOKEN = "0123456789abcdef";

  const dir = mkdtempSync(join(tmpdir(), "render-jobs-"));
  process.chdir(dir);
  await import(RENDERER + "?v=" + Math.random());   // fresh module instance per call
  const html = readFileSync(join(dir, "_site", "j", "0123456789abcdef", "index.html"), "utf8");
  rmSync(dir, { recursive: true, force: true });

  const els = {};
  const el = (id) => ({
    id, value: "", checked: false, hidden: false, textContent: "", innerHTML: "",
    children: [], listeners: {},
    appendChild(c) { this.children.push(c); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
  });
  globalThis.document = {
    getElementById(id) { return (els[id] ||= el(id)); },
    createElement(tag) { return el("created-" + tag); },
  };
  els.digest = el("digest");
  els.digest.textContent =
    html.match(/<script id="digest" type="application\/json">([\s\S]*?)<\/script>/)[1];
  // the stub invents elements, so seed the static hidden state from the served markup
  if (/<select id="found" hidden>/.test(html)) (els.found ||= el("found")).hidden = true;

  new Function(html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1])();
  return { html, els, digest };
}

// data rows only: the empty state is also a <tr>, so count role cells instead
const rowCount = (e) => (e.innerHTML.match(/<td class="role">/g) || []).length;

// ── 1. a digest that carries found_via ─────────────────────────────────────
{
  const roles = [0, 1, 2, 3].map((i) => role(i));
  const { html, els } = await render({ date: "2026-10-18", counts: {}, roles });

  check("the source control is revealed", els.found.hidden === false, "still hidden");
  check("the served markup carries the 'all sources' default",
    /<select id="found" hidden><option value="">all sources<\/option><\/select>/.test(html));
  check("one option per distinct source", els.found.children.length === 2,
    `${els.found.children.length} options`);
  check("options carry counts",
    els.found.children.every((o) => /\(\d+\)$/.test(o.textContent)), "no counts");
  check("the column follows Board",
    /<th>Board<\/th>\s*<th>Found via<\/th>/.test(html), "header order changed");
  check("the empty-result colspan matches the column count", html.includes('colspan="9"'));
  check("every role renders by default", rowCount(els.rows) === roles.length,
    `${rowCount(els.rows)} of ${roles.length}`);
  check("no cell renders 'undefined'", !/undefined/.test(els.rows.innerHTML));

  els.found.value = "CareerHound";
  els.found.listeners.change.forEach((fn) => fn());
  check("the source filter selects exactly its rows", rowCount(els.rows) === 2,
    `${rowCount(els.rows)} rows`);
  check("the count line follows the filter", els.count.textContent === "2 of 4",
    els.count.textContent);

  els.board.value = "linkedin";
  els.board.listeners.change.forEach((fn) => fn());
  check("board and source filters AND together", rowCount(els.rows) === 0,
    `${rowCount(els.rows)} rows (CareerHound rows are all ashby)`);

  els.found.value = ""; els.board.value = "";
  els.board.listeners.change.forEach((fn) => fn());
  check("clearing both restores every row", rowCount(els.rows) === 4);

  els.q.value = "hiringcafe";
  els.q.listeners.input.forEach((fn) => fn());
  check("the search box matches the source name", rowCount(els.rows) === 2,
    `${rowCount(els.rows)} rows`);
  els.q.value = "";
  els.q.listeners.input.forEach((fn) => fn());
}

// ── 2. a digest written before found_via existed ───────────────────────────
{
  const roles = [0, 1].map((i) => {
    const r = role(i);
    delete r.found_via;
    delete r.found_section;
    return r;
  });
  const { html, els } = await render({ date: "2026-10-01", counts: {}, roles });
  check("an older digest keeps the source control hidden", els.found.hidden === true,
    "revealed on an old digest");
  check("an older digest still renders every role", rowCount(els.rows) === 2);
  check("a missing found_via falls back to an em dash", els.rows.innerHTML.includes("\u2014"));
  check("the new column is still in the header", /<th>Found via<\/th>/.test(html));
}

// ── 3. hostile digest text must not become markup ──────────────────────────
// The digest is untrusted: titles/companies come from scraped boards. Every cell is
// assigned through innerHTML, so esc() has to escape and a url scheme has to be
// checked — encodeURI() leaves `javascript:` alone.
{
  const payload = "<img src=x onerror=\"alert(1)\"> & 'q'";
  const escaped = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;";
  const roles = [
    role(0, {
      title: payload, company: payload, location: payload, comp: payload,
      board: payload, found_via: payload, found_section: payload,
    }),
    role(1, { url: "javascript:alert(document.domain)" }),
    role(2, { url: "data:text/html,<script>alert(1)</script>" }),
  ];
  const { els } = await render({ date: "2026-10-18", counts: {}, roles });
  const cells = els.rows.innerHTML;
  const occurrences = cells.split(escaped).length - 1;

  check("hostile text cannot open an element", !/<img/i.test(cells), "raw <img> in a cell");
  check("hostile text cannot carry an attribute value", !/onerror="alert/i.test(cells),
    "raw onerror=\" in a cell");
  check("every hostile field is escaped, not dropped", occurrences === 6,
    `${occurrences} escaped occurrences of the payload, wanted 6 (title/company/location/comp/board/found_via)`);
  check("quotes and ampersands are escaped", cells.includes("&amp; &#39;q&#39;"),
    "ampersand or quote left raw");
  check("no half-escaped entity is left behind", !/&(?!(amp|lt|gt|quot|#39);)/.test(cells),
    "a bare & survived escaping");
  check("a javascript: url emits no live anchor", !/href\s*=\s*["']?\s*javascript:/i.test(cells),
    "href=javascript: present");
  check("a data: url emits no live anchor", !/href\s*=\s*["']?\s*data:/i.test(cells),
    "href=data: present");
  check("only the http(s) url becomes a link", (cells.match(/<a /g) || []).length === 1,
    `${(cells.match(/<a /g) || []).length} anchors`);
  check("the http(s) url keeps its anchor",
    cells.includes('href="https://example.test/0"'), "anchor lost");
  const rowFor = (text) =>
    (cells.match(/<tr>[\s\S]*?<\/tr>/g) || []).find((row) => row.includes(text)) || "";
  // Role 1's url is javascript: and Role 2's is data: — each row must render its title
  // with no anchor at all, not merely "the title appears somewhere in the table".
  const rejected = rowFor("Role 1");
  const rejectedData = rowFor("Role 2");
  check("a rejected url renders its title in a row with no anchor",
    rejected.includes("Role 1") && !/<a\s/.test(rejected) && !/href=/.test(rejected),
    "rejected row: " + rejected);
  check("a rejected data: url renders its title in a row with no anchor",
    rejectedData.includes("Role 2") && !/<a\s/.test(rejectedData) && !/href=/.test(rejectedData),
    "rejected row: " + rejectedData);
}

// ── 4. score and age are numbers, not markup ───────────────────────────────
// Both are coerced before they reach innerHTML. Numeric fields are still JSON from an
// untrusted digest, so a string there must never be concatenated into a cell.
{
  const hostile = "<img src=x onerror=alert(1)>";
  const roles = [
    role(0, { score: 20, age: 3 }),
    role(1, { score: hostile, age: hostile }),
    role(2, { score: null, age: null }),
  ];
  const { els } = await render({ date: "2026-10-18", counts: {}, roles });
  const cells = els.rows.innerHTML;

  check("a hostile score or age cannot open an element", !/<img/i.test(cells),
    "raw <img> in a numeric cell");
  check("a hostile score or age is dropped, not rendered", !/onerror/i.test(cells),
    "the payload survived into a numeric cell");
  check("a non-numeric score falls back to 0",
    (cells.match(/<td class="num">0<\/td>/g) || []).length === 2,
    `${(cells.match(/<td class="num">0<\/td>/g) || []).length} zero score cells, wanted 2 (hostile + null)`);
  check("a non-numeric age falls back to an em dash",
    (cells.match(/<td class="num muted">\u2014<\/td>/g) || []).length === 2,
    `${(cells.match(/<td class="num muted">\u2014<\/td>/g) || []).length} em-dash age cells, wanted 2 (hostile + null)`);
  check("a well-formed score still renders", cells.includes('<td class="num">20</td>'),
    "score 20 missing");
  check("a well-formed age still renders", cells.includes('<td class="num muted">3d</td>'),
    "3d missing");
}

// ── 5. the digest date is escaped where the Node-side template uses it ─────
// <title> and <h1> are built by the renderer itself, before any client-side esc()
// exists, so a hostile date must be escaped on the Node side.
{
  const hostile = "2026-10-18<img src=x onerror=alert(1)>";
  const { html } = await render({ date: hostile, counts: {}, roles: [role(0)] });
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
  const h1 = html.match(/<h1>([\s\S]*?)<\/h1>/)[1];

  check("a hostile date cannot open an element in <title>", !/<img/i.test(title),
    "raw <img> in <title>: " + title);
  check("a hostile date cannot open an element in <h1>", !/<img/i.test(h1),
    "raw <img> in <h1>: " + h1);
  check("a hostile date cannot break out of <title>", !/[<>]/.test(title),
    "an unescaped angle bracket in <title>: " + title);
  check("a hostile date cannot break out of <h1>", !/[<>]/.test(h1),
    "an unescaped angle bracket in <h1>: " + h1);
  check("a hostile date is escaped, not dropped",
    title === "Jobs 2026-10-18&lt;img src=x onerror=alert(1)&gt;", "title was: " + title);
  check("the h1 keeps its date, escaped",
    h1 === "Job digest &middot; 2026-10-18&lt;img src=x onerror=alert(1)&gt;", "h1 was: " + h1);

  const { html: plain } = await render({ date: "2026-10-18", counts: {}, roles: [role(0)] });
  check("a well-formed date renders unchanged in <title>",
    plain.includes("<title>Jobs 2026-10-18</title>"), "title changed");
  check("a well-formed date renders unchanged in <h1>",
    plain.includes('<h1>Job digest &middot; 2026-10-18</h1>'), "h1 changed");
  const { html: none } = await render({ date: undefined, counts: {}, roles: [role(0)] });
  check("a missing date still renders bare headings",
    none.includes("<title>Jobs </title>") && none.includes("<h1>Job digest</h1>"),
    "missing-date markup changed");
}

// ── 6. the summary line is a text sink, not markup ─────────────────────────
// `summary` is assigned through textContent, which does not parse entities, so the
// generated string must go in raw: escaping it would display "&amp;" to the reader.
// Raw is safe here precisely because nothing parses the value as HTML.
{
  const generated = "Tom & Jerry's <b>run</b> \"done\"";
  const { els } = await render({
    date: "2026-10-18", counts: { verify: 1 }, generated, roles: [role(0)],
  });
  const summary = els.summary.textContent;

  check("the summary shows the generated text raw",
    summary === "1 roles \u00b7 1 to verify \u00b7 generated " + generated,
    "summary was: " + summary);
  check("the summary carries no HTML entities", !/&(amp|lt|gt|quot|#39);/.test(summary),
    "entities in a textContent sink: " + summary);
  check("the summary is a text node, never parsed markup",
    els.summary.innerHTML === "" && summary.includes("<b>run</b>"),
    "summary innerHTML: " + JSON.stringify(els.summary.innerHTML));

  const { els: noGen } = await render({ date: "2026-10-18", counts: {}, roles: [role(0)] });
  check("a missing generated still renders as before",
    noGen.summary.textContent === "1 roles \u00b7 generated ",
    "summary was: " + noGen.summary.textContent);
}

// ── 7. optional: a real digest, passed on the command line ─────────────────
const real = process.argv[2];
if (real) {
  const digest = JSON.parse(readFileSync(real, "utf8"));
  const { els } = await render(digest);
  const n = digest.roles.length;
  check(`real digest: all ${n} roles render`, rowCount(els.rows) === n,
    `${rowCount(els.rows)} of ${n}`);
  const src = digest.roles.find((r) => r.found_via);
  if (src) {
    els.found.value = src.found_via;
    els.found.listeners.change.forEach((fn) => fn());
    const want = digest.roles.filter((r) => r.found_via === src.found_via).length;
    check(`real digest: filtering ${JSON.stringify(src.found_via)} gives ${want}`,
      rowCount(els.rows) === want, `${rowCount(els.rows)} rows`);
  } else {
    check("real digest: no found_via, control hidden", els.found.hidden === true);
  }
}

console.log();
if (fails.length) {
  console.log(`FAILED (${fails.length}):\n  - ` + fails.join("\n  - "));
  process.exit(1);
}
console.log("all render-jobs checks passed");
