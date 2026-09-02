/**
 * Build `index.json` from the organisation and from each plugin's own files.
 *
 * Which repositories are plugins is asked of GitHub, not kept in a list here: every
 * repository carrying both the `scmjs` and `plugin` topics is one. Publishing a plugin
 * is then a matter of topping its repository with those two topics — there is nothing to
 * remember to edit afterwards, and a repository that stops being a plugin stops being
 * listed when its topics come off.
 *
 * `plugins.json` holds only what the topics cannot say: the search tags, which plugins the
 * editor ships as defaults, repositories outside the organisation, and anything to leave
 * out. An entry there is an *override* — a discovered repository that also appears in the
 * list takes the list's tags and default flag and is not listed twice.
 *
 * What an entry says about a plugin is read from the plugin. The newest semver tag is the
 * release: its commit is what the entry describes, and the `plugin.json` at that commit
 * supplies the name, version, description and icon. A repository with no semver tag falls
 * back to its default branch, so a plugin is listed from its first push and starts naming
 * a release the first time it is tagged. The tag never reaches the `spec`, which stays
 * floating (`github:owner/repo`): the editor compares a registry row against the installed
 * list by that string, and a spec carrying `@v1.0.0` would not match the same plugin
 * installed from its branch. What Install pins is whatever the confirmation resolves at
 * the time, which may be newer than the release named here.
 *
 * The file is only rewritten when an entry actually changed: `generated` is excluded from
 * the comparison, so an hourly run over unchanged plugins commits nothing.
 *
 * Usage: node scripts/build-index.mjs [--out index.json]
 * `GITHUB_TOKEN` is used when set (higher API rate limits); none is required.
 */
import { readFile, writeFile } from "node:fs/promises";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "index.json";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "scm-js-registry",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Every page of a list endpoint, followed through the Link header. */
async function getAll(url) {
  const out = [];
  let next = `${url}${url.includes("?") ? "&" : "?"}per_page=100`;
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${next}`);
    out.push(...(await res.json()));
    next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
  }
  return out;
}

async function getText(url) {
  const res = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const repoKey = (repo, dir) => `${repo.toLowerCase()}${dir ? `/${dir.toLowerCase()}` : ""}`;

/* ── Releases ───────────────────────────────────────────── */

/**
 * A tag name as a comparable version, or null for one that is not semver. A leading `v`
 * is optional and build metadata is ignored; a prerelease sorts below the release it
 * leads to, so `v1.1.0-rc.1` never wins over `v1.0.0`... it wins over nothing but
 * `v1.1.0`'s own earlier prereleases, which is the useful half of the rule here.
 */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Newest first. Only the ordering matters, so the prerelease rule is kept simple. */
function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return b[k] - a[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return -1; // a release beats any prerelease of the same version
  if (b.pre === null) return 1;
  return a.pre < b.pre ? 1 : -1;
}

/** The repository's newest semver tag, or null when it has never been tagged. */
async function newestTag(owner, name) {
  const tags = await getAll(`https://api.github.com/repos/${owner}/${name}/tags`);
  const versioned = tags
    .map((t) => ({ name: t.name, sha: t.commit?.sha, version: parseVersion(t.name) }))
    .filter((t) => t.version && t.sha);
  if (versioned.length === 0) return null;
  versioned.sort((a, b) => compareVersions(a.version, b.version));
  return versioned[0];
}

/* ── One entry ──────────────────────────────────────────── */

/**
 * One repository → one registry entry. `repo` is the GitHub object when the organisation
 * listing already supplied it, so a discovered plugin costs no extra request for it.
 */
async function entryFor(listed, repo) {
  const [owner, name] = listed.repo.split("/");
  if (!owner || !name) throw new Error(`"repo" must be owner/name, not "${listed.repo}"`);
  const dir = (listed.dir ?? "").replace(/^\/+|\/+$/g, "");

  repo ??= await getJson(`https://api.github.com/repos/${owner}/${name}`);
  if (repo.archived) console.warn(`! ${listed.repo} is archived`);

  // The newest tag is the release; an untagged repository is described by its branch.
  const tag = await newestTag(owner, name);
  const ref = tag ? tag.sha : repo.default_branch;
  const head = await getJson(`https://api.github.com/repos/${owner}/${name}/commits/${ref}`);
  const sha = head.sha;

  const manifestUrl = `https://raw.githubusercontent.com/${owner}/${name}/${sha}/${dir ? `${dir}/` : ""}plugin.json`;
  const manifest = JSON.parse(await getText(manifestUrl));
  if (!str(manifest.name)) throw new Error(`${manifestUrl} has no "name"`);

  // The version is the author's, from the manifest at that commit; the tag only chose the
  // commit. They should agree, and a release where they do not is worth saying out loud.
  const version = str(manifest.version);
  if (tag && version && parseVersion(tag.name) && version !== tag.name.replace(/^v/, "")) {
    console.warn(`! ${listed.repo} is tagged ${tag.name} but its plugin.json says ${version}`);
  }

  const spec = `github:${owner}/${name}${dir ? `/${dir}` : ""}`;
  const web = `https://github.com/${owner}/${name}${dir ? `/tree/${repo.default_branch}/${dir}` : ""}`;
  const entry = {
    spec,
    name: str(manifest.name),
    version,
    description: str(manifest.description) ?? str(repo.description),
    author: str(manifest.author),
    repo: web,
    homepage: str(manifest.homepage) ?? str(repo.homepage),
    // Verbatim: the editor resolves a relative icon against the plugin's own files.
    icon: str(manifest.icon),
    api: typeof manifest.api === "number" ? manifest.api : undefined,
    tags: Array.isArray(listed.tags) && listed.tags.length > 0 ? listed.tags.map(String) : undefined,
    tag: tag?.name,
    commit: sha,
    updated: head.commit?.committer?.date ?? head.commit?.author?.date,
    default: listed.default === true ? true : undefined,
  };
  for (const [k, v] of Object.entries(entry)) if (v === undefined) delete entry[k];
  return entry;
}

/* ── Discovery ──────────────────────────────────────────── */

/**
 * The organisation's plugin repositories: public, not archived, carrying every topic in
 * `discover.topics`. Private repositories are skipped because the index is public and
 * `raw.githubusercontent.com` would not serve their files to the editor anyway.
 */
async function discover(discovery, excluded) {
  if (!discovery?.org) return [];
  const want = (discovery.topics ?? []).map((t) => String(t).toLowerCase());
  const repos = await getAll(`https://api.github.com/orgs/${discovery.org}/repos?type=public`);
  const found = [];
  for (const repo of repos) {
    if (repo.private || repo.archived) continue;
    const topics = (repo.topics ?? []).map((t) => t.toLowerCase());
    if (!want.every((t) => topics.includes(t))) continue;
    if (excluded.has(repoKey(repo.full_name))) {
      console.log(`- ${repo.full_name} is excluded`);
      continue;
    }
    found.push(repo);
  }
  return found;
}

/* ── The index ──────────────────────────────────────────── */

async function main() {
  const listing = JSON.parse(await readFile("plugins.json", "utf8"));
  const overrides = Array.isArray(listing.plugins) ? listing.plugins : [];
  const excluded = new Set((listing.exclude ?? []).map((r) => repoKey(String(r))));

  // The list in plugins.json comes first — it is where the tags and default flags are —
  // and discovery adds every other repository wearing the topics.
  const jobs = overrides
    .filter((l) => !excluded.has(repoKey(l.repo, l.dir)))
    .map((l) => ({ listed: l, repo: null }));
  const listedKeys = new Set(jobs.map((j) => repoKey(j.listed.repo, j.listed.dir)));

  let discovered = [];
  try {
    discovered = await discover(listing.discover, excluded);
  } catch (err) {
    // Losing discovery must not empty the registry: the listed plugins still build.
    console.warn(`! could not list ${listing.discover?.org}: ${err.message}`);
  }
  for (const repo of discovered) {
    const key = repoKey(repo.full_name);
    if (listedKeys.has(key)) {
      // Already in plugins.json — reuse the org listing so it costs no extra request.
      const job = jobs.find((j) => repoKey(j.listed.repo, j.listed.dir) === key);
      if (job && !job.listed.dir) job.repo = repo;
      continue;
    }
    jobs.push({ listed: { repo: repo.full_name }, repo });
    listedKeys.add(key);
  }

  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }

  const plugins = [];
  const failed = [];
  for (const { listed, repo } of jobs) {
    try {
      const entry = await entryFor(listed, repo);
      plugins.push(entry);
      const at = entry.tag ?? `${repo?.default_branch ?? "HEAD"} (untagged)`;
      console.log(`✓ ${entry.spec}  ${entry.name} v${entry.version ?? "?"}  ${at}  ${entry.commit.slice(0, 7)}`);
    } catch (err) {
      // A repository that will not answer keeps whatever the last good run said about it:
      // a rate limit or a moment of GitHub being down must not empty the registry.
      const spec = `github:${listed.repo}${listed.dir ? `/${listed.dir}` : ""}`;
      const kept = previous?.plugins?.find((p) => p.spec === spec);
      failed.push(`${spec}: ${err.message}`);
      console.warn(`! ${spec}: ${err.message}${kept ? " (keeping the entry from the last run)" : ""}`);
      if (kept) plugins.push(kept);
    }
  }
  if (plugins.length === 0) throw new Error(`No plugin could be read:\n${failed.join("\n")}`);

  plugins.sort((a, b) => a.name.localeCompare(b.name));
  const index = {
    format: 1,
    name: listing.name ?? "Plugins",
    description: listing.description,
    generated: new Date().toISOString(),
    plugins,
  };

  const same = (a, b) => JSON.stringify({ ...a, generated: null }) === JSON.stringify({ ...b, generated: null });
  if (previous && same(previous, index)) {
    console.log("index.json is unchanged.");
    return;
  }
  await writeFile(OUT, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Wrote ${OUT}: ${plugins.length} plugins${failed.length ? `, ${failed.length} could not be read` : ""}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
