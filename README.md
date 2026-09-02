# scm-js plugin registry

The list of plugins [scm-js](https://github.com/scm-js/scm-js) offers to install. The
editor fetches [`index.json`](index.json) when you open **Plugins ▸ Browse Plugins…**,
searches it, and installs from it.

`index.json` is generated. Which repositories are plugins is asked of GitHub: every
public, non-archived repository in the [scm-js](https://github.com/scm-js) organisation
that is either **named `plugin-…`** or carries both the `scmjs` and `plugin` topics. Everything an entry says about a
plugin is read from the plugin itself — name, version, description, author and icon come
from its own `plugin.json` — so nothing here can drift from what its author wrote.
[`plugins.json`](plugins.json) holds only what the topics cannot say: search tags, which
plugins the editor ships as defaults, repositories outside the organisation, and anything
to leave out.

## Which commit an entry describes

The newest semver tag is the release. An entry's `commit`, `version` and `updated` come
from that tag, so pushing to a plugin's default branch does not change what Browse shows
until you tag it. A repository that has never been tagged falls back to its default
branch, which is what makes a brand new plugin appear before its first release.

The tag never reaches `spec`, which stays floating (`github:owner/name`). The editor
matches a Browse row against the installed list by that string, and a spec carrying
`@v1.0.0` would not match the same plugin installed from its branch. So `commit` and
`tag` describe the release; the pin an install actually takes is resolved at install
time and may be newer.

## Reviewed

Being listed is automatic. Being **reviewed** is not: it means someone here read that
plugin's code at that release, and it is the only thing in the index that carries any
judgement about a plugin.

A review is of code, not of a repository, so `reviewed` in `plugins.json` names the
version or commit that was read:

```json
{ "repo": "scm-js/plugin-paint", "reviewed": "1.0.0" }
```

The build keeps the mark only while it still describes what is being listed. Tag a new
release and the mark disappears until someone reads it again and bumps the number — a
mark that outlived its own release would vouch for code nobody has seen, which is worse
than no mark. A commit (`"reviewed": "e869fa0"`) is the stronger form: a version
identifies the code only as well as its tag does, and a tag can be moved.

It is still not a safety guarantee, and it is not a sandbox. It says a person read it.

## What being listed means

It means the editor will *offer* the plugin. It is not a review, and it is not a sandbox:
a plugin runs with the same privileges as the editor, and can read and change the map you
have open. Installing one from Browse goes through exactly the same confirmation as
pasting its address by hand — the manifest, the addresses the code will be fetched from,
the commit being pinned, and the warning. The registry decides what appears in the list,
never what is trusted.

## Adding a plugin

For a repository in the scm-js organisation, name it `plugin-something`. That is the
whole step. Giving it the `scmjs` and `plugin` topics works too, for a plugin whose name
does not start that way — either signal is enough, because the two get forgotten at
different rates and only one of them has to be remembered.

The consequence is that listing is opt-*out*: a repository named like a plugin, with a
readable `plugin.json`, is published without anyone here saying so. `exclude` is what
holds one back. Being listed therefore says nothing about the code having been read.

For one anywhere else, or to give a plugin search tags, open a pull request adding an
entry to `plugins.json`:

```json
{
  "repo": "owner/name",
  "dir": "plugins/my-plugin",
  "tags": ["terrain", "tools"],
  "default": false
}
```

- `repo` — the GitHub repository, `owner/name`. Required.
- `dir` — the folder holding `plugin.json`, when it is not the repository root.
- `tags` — words the editor's search matches on, besides the name and description.
- `default` — true only for the plugins the editor ships with (`src/plugins/defaults.ts`);
  it is what puts the *default* badge on the row.
- `reviewed` — the version or commit whose code was read. See **Reviewed** above.

An entry for a repository the topics already found is an override: it adds the tags and
the default flag, and the plugin is still listed once. `exclude` is the other way round —
a list of `owner/name` to leave out however they are found.

The plugin needs a `plugin.json` with at least a `name`, and should carry `version`,
`description`, `author` and `icon`. See
[`docs/plugins.md`](https://github.com/scm-js/scm-js/blob/main/docs/plugins.md).

A plugin that stops answering keeps its last known entry rather than disappearing on a
network blink.

## When it rebuilds

Hourly, on a push to `plugins.json` or the generator, on demand, and whenever a plugin
repository says it changed. That last one is [`notify.yml`](.github/workflows/notify.yml),
which each plugin repository calls from a workflow of its own:

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

It exists because a repository's own `GITHUB_TOKEN` cannot start a workflow in another
repository. `REGISTRY_PAT` is an organisation secret holding a fine-grained token with
`Contents: write` on this repository and nothing else; `secrets: inherit` is what passes
it through. Anything with write access here can do the same by hand:

```sh
gh api repos/scm-js/registry/dispatches -f event_type=plugin-updated
```

None of this is load-bearing — the hourly schedule picks every change up anyway. It only
shortens the wait from up to an hour to about a minute.

## The file

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

`spec` is the only field the editor installs from, and it is an ordinary plugin address:
anything you could paste into **Plugins ▸ Manage Plugins**. An entry with no `tag` is one
read from a repository that has never been tagged.

Unknown fields are ignored, and an entry the editor cannot use is skipped rather than
breaking the list.

## Another registry

Nothing about this repository is special. Any URL serving a file of that shape is a
registry: put one anywhere the browser can read it (with CORS), and add it under
**Browse ▸ Sources** in the editor. A fork with its own plugins does that rather than
patching the editor.

## Building it locally

```sh
node scripts/build-index.mjs          # rewrites index.json if an entry changed
GITHUB_TOKEN=$(gh auth token) node scripts/build-index.mjs   # higher API rate limits
```

MIT, like the editor.
