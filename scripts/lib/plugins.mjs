/**
 * Reading a plugin repository: the GitHub calls, the release rule, and one repository as
 * a registry entry.
 *
 * It lives here rather than in `build-index.mjs` because two things read a plugin and
 * they have to agree. The index is built from it hourly; `check-submission.mjs` runs it
 * over a repository somebody has offered, so what a submitter is told about their plugin
 * is what the index would say about it, not a second opinion written beside it.
 *
 * `GITHUB_TOKEN` is used when set (higher API rate limits); none is required.
 */

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "scm-js-registry",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

export async function getJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Every page of a list endpoint, followed through the Link header. */
export async function getAll(url) {
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

/** A file from a repository. Not the API: raw.githubusercontent is what the editor reads too. */
export async function getText(url) {
  const res = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** Whether a file exists, without pulling it down. */
export async function exists(url) {
  const res = await fetch(url, { method: "HEAD", headers: { "user-agent": headers["user-agent"] } });
  return res.ok;
}

export const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
export const repoKey = (repo, dir) => `${repo.toLowerCase()}${dir ? `/${dir.toLowerCase()}` : ""}`;

/** `owner/name` from either form of address a person might paste. */
export function parseRepo(input) {
  const s = String(input ?? "").trim().replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

/* ── Releases ───────────────────────────────────────────── */

/**
 * A tag name as a comparable version, or null for one that is not semver. A leading `v`
 * is optional and build metadata is ignored; a prerelease sorts below the release it
 * leads to, so `v1.1.0-rc.1` never wins over `v1.0.0`... it wins over nothing but
 * `v1.1.0`'s own earlier prereleases, which is the useful half of the rule here.
 */
export function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Newest first. Only the ordering matters, so the prerelease rule is kept simple. */
export function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return b[k] - a[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return -1; // a release beats any prerelease of the same version
  if (b.pre === null) return 1;
  return a.pre < b.pre ? 1 : -1;
}

/** The repository's newest semver tag, or null when it has never been tagged. */
export async function newestTag(owner, name) {
  const tags = await getAll(`https://api.github.com/repos/${owner}/${name}/tags`);
  const versioned = tags
    .map((t) => ({ name: t.name, sha: t.commit?.sha, version: parseVersion(t.name) }))
    .filter((t) => t.version && t.sha);
  if (versioned.length === 0) return null;
  versioned.sort((a, b) => compareVersions(a.version, b.version));
  return versioned[0];
}

/* ── Reviews ────────────────────────────────────────────── */

/**
 * The `reviewed` mark, kept only while it still describes the code being listed.
 *
 * It is a claim that someone here read a *particular* release — so it is declared in
 * plugins.json as the version or commit that was read, not as `true`, and it is dropped
 * again the moment the plugin moves past it. A mark that survived its own release would
 * end up vouching for code nobody has seen, which is worse than no mark at all.
 *
 * A commit is the stronger form. A version is easier to read and to keep up to date, but
 * it identifies the code only as well as the tag does, and a tag can be moved.
 */
function reviewedMark(declared, version, sha, repo, warn) {
  const want = str(declared);
  if (!want) return undefined;
  if (version && want === version) return version;
  if (/^[0-9a-f]{7,40}$/i.test(want) && sha.toLowerCase().startsWith(want.toLowerCase())) return version ?? want;
  warn(`${repo}: reviewed ${want}, but the release listed is ${version ?? sha.slice(0, 7)} — dropping the mark`);
  return undefined;
}

/* ── One entry ──────────────────────────────────────────── */

/**
 * One repository → one registry entry, plus everything read on the way there so a caller
 * that wants to say more about the plugin than the entry holds need not fetch it twice.
 *
 * `repo` is the GitHub object when the organisation listing already supplied it, so a
 * discovered plugin costs no extra request for it.
 */
export async function entryFor(listed, repo, { warn = (m) => console.warn(`! ${m}`) } = {}) {
  const [owner, name] = listed.repo.split("/");
  if (!owner || !name) throw new Error(`"repo" must be owner/name, not "${listed.repo}"`);
  const dir = (listed.dir ?? "").replace(/^\/+|\/+$/g, "");

  repo ??= await getJson(`https://api.github.com/repos/${owner}/${name}`);
  if (repo.archived) warn(`${listed.repo} is archived`);

  // The newest tag is the release; an untagged repository is described by its branch.
  const tag = await newestTag(owner, name);
  const ref = tag ? tag.sha : repo.default_branch;
  const head = await getJson(`https://api.github.com/repos/${owner}/${name}/commits/${ref}`);
  const sha = head.sha;

  const base = `https://raw.githubusercontent.com/${owner}/${name}/${sha}/${dir ? `${dir}/` : ""}`;
  const manifestUrl = `${base}plugin.json`;
  let manifest;
  try {
    manifest = JSON.parse(await getText(manifestUrl));
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? `${manifestUrl} is not valid JSON` : err.message);
  }
  if (!str(manifest.name)) throw new Error(`${manifestUrl} has no "name"`);

  // The version is the author's, from the manifest at that commit; the tag only chose the
  // commit. They should agree, and a release where they do not is worth saying out loud.
  const version = str(manifest.version);
  if (tag && version && parseVersion(tag.name) && version !== tag.name.replace(/^v/, "")) {
    warn(`${listed.repo} is tagged ${tag.name} but its plugin.json says ${version}`);
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
    reviewed: reviewedMark(listed.reviewed, version, sha, listed.repo, warn),
    tag: tag?.name,
    commit: sha,
    updated: head.commit?.committer?.date ?? head.commit?.author?.date,
    default: listed.default === true ? true : undefined,
  };
  for (const [k, v] of Object.entries(entry)) if (v === undefined) delete entry[k];
  return { entry, manifest, repo, tag, sha, dir, base, manifestUrl };
}
