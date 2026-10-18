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

// ── 3. optional: a real digest, passed on the command line ─────────────────
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
