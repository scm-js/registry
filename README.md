# scm-js plugin registry

The list of plugins that [scmJS](https://github.com/scm-js/scm-js) offers to install. When you
open **Plugins ▸ Browse Plugins…**, the editor fetches [`index.json`](index.json) from this
repository, searches it, and installs from it.

`index.json` is generated. A plugin's name, version, description, author and icon are read
from the plugin's own `plugin.json`, so the list always says what the plugin's author wrote.
[`plugins.json`](plugins.json) holds only what the plugins cannot say for themselves: search
tags, which plugins the editor ships as defaults, repositories outside the organisation, and
repositories to leave out.

## Getting a plugin listed

### Inside the scm-js organisation

Name the repository `plugin-something`. Any public, non-archived repository in the
[scm-js](https://github.com/scm-js) organisation with a readable `plugin.json` is listed if
its name starts with `plugin-` or it has both the `scmjs` and `plugin` topics. Nobody has to
approve it. Add it to `exclude` in `plugins.json` to keep it out.

### From anywhere else

1. [Open a submission](https://github.com/scm-js/registry/issues/new?template=submit-plugin.yml).
   The form asks for the repository (`owner/name` or its address), the folder holding
   `plugin.json` if it is not at the top, and up to eight search tags. Tick the four boxes
   at the bottom.
2. A bot replies within a minute with what it found. If something blocks the listing, fix it
   and edit the issue. The bot checks again and rewrites the same comment.
3. A maintainer reads the code and adds the `approved` label. This opens a pull request that
   adds your entry to `plugins.json`.
4. When the pull request is merged, the plugin appears in Browse within the hour.

There is nothing to repeat on the form and nothing to keep up to date here afterwards. Your
plugin's details are read from `plugin.json` at your newest version tag.

The bot uses [`scripts/check-submission.mjs`](scripts/check-submission.mjs), which reads your
repository the same way the index build does. What it reports is what the index will say.

These findings block a listing:

- no `plugin.json` at the release commit (or in the folder you named)
- a repository GitHub will not serve to an anonymous visitor (private, or misspelled)
- an entry file that `plugin.json` names but that is not there, or no entry file at all
- an `api` newer than the editor supports (it supports 1)
- a repository that is already listed, or is on the `exclude` list
- boxes on the form left unticked

These are worth fixing but do not block it: no version tag yet, no `author` or other manifest
field, no `api`, no licence, a minified bundle, an archived repository or a fork.

You can run the same check before you submit:

```sh
node scripts/check-submission.mjs owner/name --tags terrain,tools
node scripts/check-submission.mjs owner/name --dir plugins/my-plugin
```

## What being listed means

Being listed means the editor will offer the plugin. It does not mean anyone has read the
code. A plugin runs with the same privileges as the editor and can read and change the open
map. Installing from Browse shows the same confirmation as pasting an address by hand: the
manifest, the addresses the code comes from, the commit being pinned, and the warning.

### Reviewed

A plugin marked *reviewed* is one where someone here read the code of that release. In
`plugins.json`, `reviewed` names the version or commit that was read:

```json
{ "repo": "scm-js/plugin-paint", "reviewed": "1.0.0" }
```

The mark only lasts while it describes the release being listed. When a new release is
tagged, the mark is dropped until someone reads the code again and updates the value. A
commit hash (`"reviewed": "e869fa0"`) is the stronger form, since a tag can be moved.

A review says a person read the code. It is not a safety guarantee.

## Which release an entry describes

The newest semver tag is the release. An entry's `commit`, `version` and `updated` come from
that tag, so a push to the default branch does not change what Browse shows until you tag
it. A repository with no tags is read from its default branch, so a new plugin appears before
its first release.

An entry's `spec` never carries the tag (`github:owner/name`). The editor matches Browse rows
against installed plugins by that string. The version an install pins is worked out at
install time, and may be newer than the entry's `tag`.

If a plugin repository stops answering, its last known entry is kept.

## When the index rebuilds

- every hour
- on a push to `plugins.json` or the build script
- on demand (**Actions ▸ Build index ▸ Run workflow**)
- when a plugin repository says it changed

For the last one, a plugin repository calls [`notify.yml`](.github/workflows/notify.yml) from
a workflow of its own:

```yaml
name: Notify registry
on:
  push:
    branches: [main]
    tags: ["v*"]
jobs:
  notify:
    uses: scm-js/registry/.github/workflows/notify.yml@main
    secrets: inherit
```

A repository's own `GITHUB_TOKEN` cannot start a workflow in another repository. So
`REGISTRY_PAT`, an organisation secret, holds a fine-grained token with `Contents: write` on
this repository and nothing else. `secrets: inherit` passes it through. Anyone with write
access here can do the same by hand:

```sh
gh api repos/scm-js/registry/dispatches -f event_type=plugin-updated
```

The hourly rebuild picks up every change anyway. Notifying only cuts the wait to about a
minute.

## plugins.json

The submission flow writes entries here. Edit one by hand to give a plugin tags, change a
listing, or add a repository without an issue:

```json
{
  "repo": "owner/name",
  "dir": "plugins/my-plugin",
  "tags": ["terrain", "tools"],
  "default": false
}
```

| Field | Meaning |
| --- | --- |
| `repo` | The GitHub repository, `owner/name`. Required. |
| `dir` | The folder holding `plugin.json`, when it is not the repository root. |
| `tags` | Words the editor's search matches, besides the name and description. |
| `default` | True only for plugins the editor ships with. It puts the *default* badge on the row. |
| `reviewed` | The version or commit whose code was read. See [Reviewed](#reviewed). |

An entry for a repository that is already found by name or topic adds its tags and default
flag. The plugin is still listed once. `exclude` is a list of `owner/name` to leave out,
however they are found.

A plugin needs a `plugin.json` with at least a `name`, and should have `version`,
`description`, `author` and `icon`. The
[plugin guide](https://docs.scmjs.dev/plugins/writing-a-plugin/) describes the manifest.

## The index file

```jsonc
{
  "format": 1,
  "name": "scm-js plugins",          // what the editor calls this registry
  "description": "…",
  "generated": "2026-09-02T15:29:25.937Z",
  "plugins": [{
    "spec": "github:scm-js/plugin-paint",  // what gets installed
    "name": "Paint",
    "version": "1.0.0",
    "description": "…",
    "author": "…",
    "repo": "https://github.com/scm-js/plugin-paint",   // a page to read the source on
    "homepage": "…",
    "icon": "icon.svg",              // as the manifest wrote it, resolved by the editor
    "api": 1,                        // the plugin API version it needs
    "tags": ["terrain", "drawing"],
    "reviewed": "1.0.0",             // someone read this release; absent if nobody has
    "tag": "v1.0.0",                 // the release this entry was read from
    "commit": "7ebd209…",            // the commit that tag points at
    "updated": "2026-09-01T18:22:03Z",
    "default": true
  }]
}
```

The editor installs from `spec` only. It is an ordinary plugin address, the same as anything
you could paste into **Plugins ▸ Manage Plugins…**. An entry with no `tag` comes from a
repository that has never been tagged.

The editor ignores unknown fields and skips an entry it cannot use.

## Another registry

Any URL serving a file of that shape is a registry. Put one anywhere the browser can read it
(with CORS) and add it under **Sources** in the editor's Browse Plugins dialog. A fork with its
own plugins can do this without changing the editor.

## Running the submission workflow

[`submission.yml`](.github/workflows/submission.yml) uses four labels:

- `submission`, applied by the issue form
- `approved`, added by a maintainer, and the only step that writes anything
- `submission:passing` and `submission:blocked`, set by the check

GitHub drops a label that does not exist. On a fork, run the workflow once by hand
(**Actions ▸ Submission ▸ Run workflow**) and its `labels` job creates all four.

The job that opens the pull request needs *Allow GitHub Actions to create and approve pull
requests*. It is off by default and has to be turned on in two places: the organisation's
Actions settings first, then the repository's, which does not inherit it.

Only someone with triage or write access on the repository can label an issue, so the label
is the approval. The workflow runs the check again before writing, in case the issue was
edited after it was read.

## Building it locally

```sh
node scripts/build-index.mjs                             # rewrites index.json if an entry changed
node scripts/check-submission.mjs owner/name             # what a submission of that repository would say
node scripts/check-submission.mjs --body-file issue.md   # the same, read from a filled-in form
GITHUB_TOKEN=$(gh auth token) node scripts/build-index.mjs   # higher API rate limits
```

Both scripts read a plugin repository through [`scripts/lib/plugins.mjs`](scripts/lib/plugins.mjs),
so a submitter is told the same thing the index publishes.

## License

MIT, like the editor.
