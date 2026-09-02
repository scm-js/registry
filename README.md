# scm-js plugin registry

The list of plugins [scm-js](https://github.com/scm-js/scm-js) offers to install. The
editor fetches [`index.json`](index.json) when you open **Plugins ▸ Browse Plugins…**,
searches it, and installs from it.

`index.json` is generated. The file a person edits is [`plugins.json`](plugins.json) —
which repositories are listed — and everything else is read from the plugins themselves:
each entry's name, version, description, author and icon come from that plugin's own
`plugin.json` at the head of its default branch, so nothing here can drift from what its
author wrote.

## What being listed means

It means the editor will *offer* the plugin. It is not a review, and it is not a sandbox:
a plugin runs with the same privileges as the editor, and can read and change the map you
have open. Installing one from Browse goes through exactly the same confirmation as
pasting its address by hand — the manifest, the addresses the code will be fetched from,
the commit being pinned, and the warning. The registry decides what appears in the list,
never what is trusted.

## Adding a plugin

Open a pull request adding an entry to `plugins.json`:

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

The plugin needs a `plugin.json` with at least a `name`, and should carry `version`,
`description`, `author` and `icon`. See
[`docs/plugins.md`](https://github.com/scm-js/scm-js/blob/main/docs/plugins.md).

The index is rebuilt hourly, on a push to `plugins.json`, and on demand — so a new
version of a listed plugin appears in Browse within the hour without anything being
changed here. A plugin repository can also push the update through immediately:

```sh
gh api repos/scm-js/registry/dispatches -f event_type=plugin-updated
```

To be removed from the list, open a pull request taking the entry out (or an issue). A
plugin that stops answering keeps its last known entry rather than disappearing on a
network blink.

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
    "commit": "7ebd209…",            // the commit this entry was read from
    "updated": "2026-09-01T18:22:03Z",
    "default": true
  }]
}
```

`spec` is the only field the editor installs from, and it is an ordinary plugin address:
anything you could paste into **Plugins ▸ Manage Plugins**. `commit` and `updated`
describe the version the index was built from; the pin an install actually takes is
resolved at install time, so it may be newer.

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
