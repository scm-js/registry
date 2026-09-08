/**
 * Check a plugin somebody has offered for listing, and say what is wrong with it.
 *
 * A submission is a GitHub issue written on the form in `.github/ISSUE_TEMPLATE`. This
 * reads that issue, resolves the repository exactly as `build-index.mjs` would — same
 * `lib/plugins.mjs`, same release rule, same manifest — and writes a report to comment
 * back with. The point of sharing the resolution is that a submitter is told what the
 * index will say about their plugin rather than a second opinion written beside it; if
 * this passes and the entry lands, the row appears.
 *
 * It checks and it explains. It does not decide: listing a repository from outside the
 * organisation is a person's decision, because the editor has no sandbox and a listed
 * plugin is one the editor offers. What this removes is the part that was work for
 * nobody's benefit — learning the shape of `plugins.json`, forking, and finding out from
 * a review comment that the manifest has no `author`.
 *
 * Usage:
 *   node scripts/check-submission.mjs --body-file issue.md [--report r.md] [--result r.json] [--write plugins.json]
 *   node scripts/check-submission.mjs owner/name [--dir sub/dir] [--tags terrain,tools]
 *
 * Exit code: 0 nothing blocking, 2 blocked, 1 the check itself broke.
 * `GITHUB_TOKEN` is used when set (higher API rate limits); none is required.
 */
import { readFile, writeFile } from "node:fs/promises";
import { entryFor, exists, getJson, parseRepo, repoKey, str } from "./lib/plugins.mjs";

/**
 * The newest `PLUGIN_API_VERSION` the editor implements (`src/plugins/api.ts`). It is a
 * constant here rather than fetched: it has been 1 since the contract existed and stays
 * there — the API is additive — so a plugin asking for 2 is a plugin from the future,
 * whatever this file was last told.
 */
const API_VERSION = 1;

/** Beyond this a bundle is one nobody is going to read. */
const MINIFIED_LINE = 2000;

const flag = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/* ── The form ───────────────────────────────────────────── */

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const EMPTY = /^_no response_$/i;

/**
 * A GitHub issue form arrives as markdown: one `### Label` per field, the answer under
 * it, and `_No response_` where the person left it blank. Fields are matched on the
 * label with everything but its letters removed, so the form's wording can be reworded
 * without this having to be edited in the same commit.
 */
export function parseIssueBody(body) {
  const fields = {};
  const parts = String(body ?? "").split(/^###[ \t]+(.+?)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const value = parts[i + 1].trim();
    fields[key(parts[i])] = EMPTY.test(value) ? "" : value;
  }
  // Only the boxes on the form's own last field: a submitter writing a to-do list of
  // their own under "Anything else" would otherwise be told their acknowledgements are
  // not ticked.
  const acks = Object.entries(fields).find(([k]) => k.startsWith("beforeyou") || k.includes("acknowledge"))?.[1];
  const boxes = [...(acks ?? String(body ?? "")).matchAll(/^[ \t]*-[ \t]*\[([ xX])\]/gm)].map((m) => m[1] !== " ");
  return {
    repo: fields.repository ?? "",
    dir: (fields.subdirectory ?? "").replace(/^\/+|\/+$/g, ""),
    tags: fields.searchtags ?? fields.tags ?? "",
    boxes,
  };
}

/** Tags as the index will hold them, and what was thrown away. */
function cleanTags(raw) {
  const words = String(raw ?? "").split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const tags = [];
  const dropped = [];
  for (const w of words) {
    if (/^[a-z0-9][a-z0-9-]{1,19}$/.test(w) && !tags.includes(w)) tags.push(w);
    else dropped.push(w);
  }
  return { tags: tags.slice(0, 8), dropped: [...dropped, ...tags.slice(8)] };
}

/* ── The checks ─────────────────────────────────────────── */

const MARK = { pass: "✅", warn: "⚠️", fail: "❌" };

class Report {
  constructor() { this.lines = []; }
  pass(text) { this.lines.push({ level: "pass", text }); }
  warn(text) { this.lines.push({ level: "warn", text }); }
  fail(text) { this.lines.push({ level: "fail", text }); }
  get blocked() { return this.lines.some((l) => l.level === "fail"); }
}

/** The first bytes of a file, so a check on a bundle does not pull the whole bundle. */
async function head(url, bytes = 200_000) {
  const res = await fetch(url, { headers: { "user-agent": "scm-js-registry", range: `bytes=0-${bytes - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return (await res.text()).slice(0, bytes);
}

/**
 * Everything the loader would have to find before the plugin runs: the manifest's `build`
 * if it has one, else its `entry`, else the two names the loader falls back to. The
 * editor probes exactly this list, so a repository that fails here fails on Install.
 */
async function checkEntry(r, manifest, base) {
  const named = str(manifest.build) ?? str(manifest.entry);
  const candidates = named ? [named] : ["plugin.ts", "plugin.js"];
  let found = null;
  for (const name of candidates) {
    if (await exists(new URL(name, base).href)) { found = name; break; }
  }
  if (!found) {
    r.fail(named
      ? `\`plugin.json\` names \`${named}\`, which is not there at that commit.`
      : "No `entry` in `plugin.json`, and neither `plugin.ts` nor `plugin.js` is there — the editor would have nothing to import.");
    return;
  }
  if (str(manifest.build) === found) {
    r.pass(`Loads from the committed bundle \`${found}\`.`);
    try {
      const text = await head(new URL(found, base).href);
      const longest = text.split("\n").reduce((n, line) => Math.max(n, line.length), 0);
      if (longest > MINIFIED_LINE) {
        r.warn(`\`${found}\` looks minified. Ship it readable — the repository is all a user has to judge the plugin by.`);
      }
    } catch (err) {
      r.warn(`Could not read \`${found}\`: ${err.message}`);
    }
  } else {
    r.pass(named ? `Loads from \`${found}\`.` : `No \`entry\` named; the editor would fall back to \`${found}\`, which is there.`);
  }
}

/** The manifest fields a row is drawn from. Missing ones are the author's to fill in. */
function checkManifest(r, manifest) {
  if (typeof manifest.api !== "number") {
    r.warn("No `api` in `plugin.json`. Name the plugin API version you wrote against.");
  } else if (manifest.api > API_VERSION) {
    r.fail(`\`api\` is ${manifest.api}; the editor implements ${API_VERSION}. Nothing could run this yet.`);
  }
  const missing = ["version", "description", "author", "icon"].filter((k) => !str(manifest[k]));
  if (missing.length > 0) {
    r.warn(`\`plugin.json\` has no ${missing.map((m) => `\`${m}\``).join(", ")}. The manifest is the whole of what a user reads before installing.`);
  } else {
    r.pass("The manifest names a version, a description, an author and an icon.");
  }
}

/* ── One submission ─────────────────────────────────────── */

export async function checkSubmission({ repo, dir, tags, boxes = null }) {
  const r = new Report();
  const listing = JSON.parse(await readFile("plugins.json", "utf8"));

  const full = parseRepo(repo);
  if (!full) {
    r.fail(`\`${String(repo).slice(0, 80) || "(nothing)"}\` is not a repository. Give it as \`owner/name\` or as its GitHub address.`);
    return { report: r, entry: null };
  }
  const [owner, name] = full.split("/");

  if (boxes && (boxes.length === 0 || boxes.some((b) => !b))) {
    r.fail("The boxes at the bottom of the form are not all ticked. Tick them and this runs again.");
  }

  const { tags: clean, dropped } = cleanTags(tags);
  if (dropped.length > 0) {
    r.warn(`Dropped ${dropped.map((d) => `\`${d}\``).join(", ")} — a tag is one word of letters, digits and hyphens, and eight is the most that are kept.`);
  }

  // Already answered for, one way or the other.
  const k = repoKey(full, dir);
  if ((listing.exclude ?? []).some((e) => repoKey(String(e)) === repoKey(full))) {
    r.fail("This repository is on the registry's `exclude` list — it is held back on purpose. Say here why it should not be.");
    return { report: r, entry: null };
  }
  if ((listing.plugins ?? []).some((p) => repoKey(p.repo, p.dir) === k)) {
    r.fail("This is already in `plugins.json`. If the listing is wrong or out of date, say what should change instead.");
    return { report: r, entry: null };
  }
  let read;
  try {
    read = await entryFor({ repo: full, dir: dir || undefined, tags: clean }, null, { warn: (m) => r.warn(m.replace(`${full}: `, "").replace(`${full} `, "This repository ")) });
  } catch (err) {
    // Two of these are ordinary mistakes and worth naming as such; anything else is
    // passed through as it came, since a guess about it would only mislead.
    const gone = /HTTP 404/.test(err.message);
    if (gone && /api\.github\.com/.test(err.message)) {
      r.fail(`GitHub has no public \`${full}\`. Check the spelling — a private repository cannot be listed, because the editor fetches a plugin's files as an anonymous visitor.`);
    } else if (gone && /raw\.githubusercontent/.test(err.message)) {
      r.fail(dir
        ? `No \`plugin.json\` in \`${dir}/\` at that commit. It goes beside the plugin's entry file, at the top of that folder.`
        : `No \`plugin.json\` at the top of \`${full}\` at that commit. If the plugin is in a folder, name the folder on the form.`);
    } else {
      r.fail(`Could not read the plugin: ${err.message}`);
    }
    return { report: r, entry: null };
  }
  const { entry, manifest, repo: meta, tag, sha, base } = read;

  const discovery = listing.discover ?? {};
  if (owner.toLowerCase() === String(discovery.org ?? "").toLowerCase()) {
    r.warn(`A repository in the ${discovery.org} organisation named \`${discovery.prefix}…\` is listed with no entry at all. This issue is only needed to give it search tags.`);
  }
  if (meta.archived) r.warn("The repository is archived, so nothing can be fixed in it while it stays that way.");
  if (meta.fork) r.warn(`This is a fork of \`${meta.parent?.full_name ?? "another repository"}\`. Submit the original unless this is your own line of it.`);
  if (!tag) r.warn("No version tag yet. The listing follows your default branch until there is one, so every push to it changes what is offered. Tag a release.");
  else r.pass(`Read from \`${tag.name}\` (\`${sha.slice(0, 7)}\`).`);

  checkManifest(r, manifest);
  await checkEntry(r, manifest, base);

  try {
    await getJson(`https://api.github.com/repos/${owner}/${name}/license`);
    r.pass("The repository has a licence.");
  } catch {
    r.warn("No licence file. Without one nobody may legally copy the plugin, which includes anyone who installs it.");
  }

  try {
    const index = JSON.parse(await readFile("index.json", "utf8"));
    // Not against itself: a plugin already in the index is one being resubmitted for tags.
    const clash = (index.plugins ?? []).find((p) => p.spec !== entry.spec && p.name?.toLowerCase() === entry.name.toLowerCase());
    if (clash) r.warn(`Another listed plugin is also called **${entry.name}** (\`${clash.spec}\`). Two rows with one name is confusing in Browse.`);
  } catch { /* no index yet */ }

  const proposed = { repo: full };
  if (dir) proposed.dir = dir;
  if (clean.length > 0) proposed.tags = clean;
  return { report: r, entry: proposed, plugin: entry, listing };
}

/* ── Saying it ──────────────────────────────────────────── */

const MARKER = "<!-- scm-js-registry: submission -->";

export function renderReport({ report, entry, plugin }) {
  const out = [MARKER, ""];
  if (plugin) {
    out.push(`**${plugin.name}**${plugin.version ? ` v${plugin.version}` : ""} — \`${plugin.spec}\``, "");
    if (plugin.description) out.push(`> ${plugin.description.split("\n")[0]}`, "");
  }
  out.push(...report.lines.map((l) => `- ${MARK[l.level]} ${l.text}`), "");
  if (report.blocked) {
    out.push("**Blocked by the ❌ above.** Fix them and edit the issue — this comment is rewritten each time, so there is no need to open another one.");
  } else {
    out.push(
      "**Nothing blocking.** Being listed is still someone's decision rather than a consequence of this passing: the editor runs a plugin with its own privileges and no sandbox, so a maintainer reads the code first. When they do, the `approved` label opens the pull request that adds the entry below, and merging it puts the plugin in Browse within the hour.",
    );
  }
  if (entry) {
    out.push("", "<details><summary>The entry this would add to <code>plugins.json</code></summary>", "", "```json", JSON.stringify(entry, null, 2), "```", "</details>");
  }
  const warnings = report.lines.filter((l) => l.level === "warn").length;
  out.push("", `<sub>Checked by <a href="../blob/main/scripts/check-submission.mjs">check-submission.mjs</a>, the same reader that builds the index — ${report.lines.filter((l) => l.level === "fail").length} blocking, ${warnings} worth fixing.</sub>`);
  return out.join("\n");
}

/** Add the entry to `plugins.json`, at the end, where an outside plugin belongs. */
async function write(file, entry) {
  const listing = JSON.parse(await readFile(file, "utf8"));
  listing.plugins = [...(listing.plugins ?? []), entry];
  await writeFile(file, `${JSON.stringify(listing, null, 2)}\n`);
}

async function main() {
  const bodyFile = flag("body-file");
  let input;
  if (bodyFile) {
    const parsed = parseIssueBody(await readFile(bodyFile, "utf8"));
    input = { repo: parsed.repo, dir: parsed.dir, tags: parsed.tags, boxes: parsed.boxes };
  } else {
    const args = process.argv.slice(2);
    const positional = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
    input = { repo: positional ?? "", dir: flag("dir", ""), tags: flag("tags", "") };
  }

  const result = await checkSubmission(input);
  const markdown = renderReport(result);
  const reportFile = flag("report");
  if (reportFile) await writeFile(reportFile, `${markdown}\n`);
  else console.log(markdown);

  const resultFile = flag("result");
  if (resultFile) {
    await writeFile(resultFile, `${JSON.stringify({
      ok: !result.report.blocked,
      repo: result.entry?.repo ?? null,
      name: result.plugin?.name ?? null,
      version: result.plugin?.version ?? null,
      entry: result.entry,
      lines: result.report.lines,
    }, null, 2)}\n`);
  }

  const writeFileName = flag("write");
  if (writeFileName) {
    if (result.report.blocked || !result.entry) throw new Error("Blocked — nothing written.");
    await write(writeFileName, result.entry);
    console.error(`Added ${result.entry.repo} to ${writeFileName}.`);
  }
  process.exit(result.report.blocked ? 2 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
