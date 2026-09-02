/**
 * Build `index.json` from `plugins.json`.
 *
 * `plugins.json` is the list a person maintains: which repositories are in the registry.
 * `index.json` is what the editor fetches, and everything else in it is read from the
 * plugins themselves — one `plugin.json` and one commit lookup each — so a plugin's name,
 * version, description and icon are always the ones its author wrote, never a copy kept
 * here that can drift.
 *
 * The file is only rewritten when an entry actually changed: `generated` is excluded from
 * the comparison, so an hourly run over seven unchanged plugins commits nothing.
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

async function getText(url) {
  const res = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** One listed repository → one registry entry, read from its own `plugin.json`. */
async function entryFor(listed) {
  const [owner, name] = listed.repo.split("/");
  if (!owner || !name) throw new Error(`"repo" must be owner/name, not "${listed.repo}"`);
  const dir = (listed.dir ?? "").replace(/^\/+|\/+$/g, "");

  const repo = await getJson(`https://api.github.com/repos/${owner}/${name}`);
  if (repo.archived) console.warn(`! ${listed.repo} is archived`);
  const head = await getJson(`https://api.github.com/repos/${owner}/${name}/commits/${repo.default_branch}`);
  const sha = head.sha;

  const manifestUrl = `https://raw.githubusercontent.com/${owner}/${name}/${sha}/${dir ? `${dir}/` : ""}plugin.json`;
  const manifest = JSON.parse(await getText(manifestUrl));
  if (!str(manifest.name)) throw new Error(`${manifestUrl} has no "name"`);

  const spec = `github:${owner}/${name}${dir ? `/${dir}` : ""}`;
  const web = `https://github.com/${owner}/${name}${dir ? `/tree/${repo.default_branch}/${dir}` : ""}`;
  const entry = {
    spec,
    name: str(manifest.name),
    version: str(manifest.version),
    description: str(manifest.description) ?? str(repo.description),
    author: str(manifest.author),
    repo: web,
    homepage: str(manifest.homepage) ?? str(repo.homepage),
    // Verbatim: the editor resolves a relative icon against the plugin's own files.
    icon: str(manifest.icon),
    api: typeof manifest.api === "number" ? manifest.api : undefined,
    tags: Array.isArray(listed.tags) && listed.tags.length > 0 ? listed.tags.map(String) : undefined,
    commit: sha,
    updated: head.commit?.committer?.date ?? head.commit?.author?.date,
    default: listed.default === true ? true : undefined,
  };
  for (const [k, v] of Object.entries(entry)) if (v === undefined) delete entry[k];
  return entry;
}

async function main() {
  const listing = JSON.parse(await readFile("plugins.json", "utf8"));
  if (!Array.isArray(listing.plugins)) throw new Error('plugins.json needs a "plugins" list.');

  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }

  const plugins = [];
  const failed = [];
  for (const listed of listing.plugins) {
    try {
      const entry = await entryFor(listed);
      plugins.push(entry);
      console.log(`✓ ${entry.spec}  ${entry.name} v${entry.version ?? "?"}  ${entry.commit.slice(0, 7)}`);
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
