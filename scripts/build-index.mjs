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
 * What an entry says about a plugin is read from the plugin, by `lib/plugins.mjs`, which
 * `check-submission.mjs` reads it with too. The newest semver tag is the release: its
 * commit is what the entry describes, and the `plugin.json` at that commit supplies the
 * name, version, description and icon. A repository with no semver tag falls back to its
 * default branch, so a plugin is listed from its first push and starts naming a release
 * the first time it is tagged. The tag never reaches the `spec`, which stays floating
 * (`github:owner/repo`): the editor compares a registry row against the installed list by
 * that string, and a spec carrying `@v1.0.0` would not match the same plugin installed
 * from its branch. What Install pins is whatever the confirmation resolves at the time,
 * which may be newer than the release named here.
 *
 * The file is only rewritten when an entry actually changed: `generated` is excluded from
 * the comparison, so an hourly run over unchanged plugins commits nothing.
 *
 * Usage: node scripts/build-index.mjs [--out index.json]
 * `GITHUB_TOKEN` is used when set (higher API rate limits); none is required.
 */
import { readFile, writeFile } from "node:fs/promises";
import { entryFor, getAll, repoKey, str } from "./lib/plugins.mjs";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "index.json";

/* ── Discovery ──────────────────────────────────────────── */

/**
 * The organisation's plugin repositories: public, not archived, and either named with
 * `discover.prefix` or carrying every topic in `discover.topics`.
 *
 * Two signals rather than one because they are forgotten at different rates. A name is
 * chosen when the repository is created and is visible in every listing; topics are
 * metadata set afterwards, and six of the eight plugins here had none until someone went
 * back and added them. Either alone would have missed a plugin, so a repository only has
 * to satisfy one of them.
 *
 * The cost of the union is that listing is opt-*out*: a repository named like a plugin and
 * carrying a readable `plugin.json` is published without anyone saying so, and `exclude` in
 * plugins.json is what holds one back. That is deliberate — a plugin nobody can find is a
 * worse failure here than one listed a release early — but it holds only inside the
 * organisation, where every repository is the project's own. A plugin from anywhere else
 * is listed by someone deciding to list it: see `check-submission.mjs`.
 *
 * Private repositories are skipped because the index is public and
 * `raw.githubusercontent.com` would not serve their files to the editor anyway.
 */
async function discover(discovery, excluded) {
  if (!discovery?.org) return [];
  const prefix = str(discovery.prefix)?.toLowerCase();
  const want = (discovery.topics ?? []).map((t) => String(t).toLowerCase());
  if (!prefix && want.length === 0) return []; // no signal at all would match everything
  const repos = await getAll(`https://api.github.com/orgs/${discovery.org}/repos?type=public`);
  const found = [];
  for (const repo of repos) {
    if (repo.private || repo.archived) continue;
    const topics = (repo.topics ?? []).map((t) => t.toLowerCase());
    const named = prefix ? repo.name.toLowerCase().startsWith(prefix) : false;
    const tagged = want.length > 0 && want.every((t) => topics.includes(t));
    if (!named && !tagged) continue;
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
      const { entry, repo: meta, tag } = await entryFor(listed, repo);
      plugins.push(entry);
      const at = tag?.name ?? `${meta?.default_branch ?? "HEAD"} (untagged)`;
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
