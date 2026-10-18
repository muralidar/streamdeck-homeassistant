# muralidar fork

Fork of [cgiesche/streamdeck-homeassistant](https://github.com/cgiesche/streamdeck-homeassistant),
built from source and installed locally instead of from the Elgato Marketplace.

## Why

Reviewed at tag `3.8.4` (2026-10-17). The access token is only used by the official
`home-assistant-js-websocket` client against the configured server URL, the debug
report redacts it, and entity pictures are fetched without it.

The one change: upstream downloads three YAML files at runtime from its `master`
branch via jsDelivr — `manifest.yml`, `active-states.yml`, and the display
configuration. The display configuration holds Nunjucks templates the plugin
renders, and Nunjucks is not a sandbox, so a change to upstream `master` (or the
CDN) could run code in the process that holds the HA token. This fork uses the
copies bundled in the build and never fetches them. A display-configuration URL
you type into the settings yourself is still honoured.

Also applied: `npm audit fix` (semver-compatible updates). Remaining advisory:
`js-yaml` 4.1.1 is pinned by upstream's `overrides`; its issues are CPU DoS on
hostile YAML, which this build no longer downloads.

Not changed: the settings panel loads a font from Google Fonts (privacy, not the token).

## Branches

- `reviewed-3.8.4` — the reviewed, patched build. Install from this.
- `upstream` remote — cgiesche's repo.

## Build and install

```sh
npm ci --ignore-scripts      # no package install scripts run
npm test
npm run build
npx streamdeck bundle -f --no-update-check ./build/de.perdoctus.streamdeck.homeassistant.sdPlugin
open ./de.perdoctus.streamdeck.homeassistant.streamDeckPlugin   # Stream Deck asks to install
```

## Taking an upstream release

```sh
git fetch upstream --tags
git log --oneline reviewed-3.8.4..<new-tag>          # what changed
git diff 3.8.4 <new-tag> -- src public package.json  # read it
git checkout -b reviewed-<new-tag> <new-tag>
git cherry-pick <the fork commits from reviewed-3.8.4>
grep -rn "jsdelivr\|fetch(\|axios" src               # re-check for new runtime downloads
```

Then build and install as above.
