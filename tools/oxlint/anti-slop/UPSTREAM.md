# Upstream

- Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7`
- Obtained via the `install-anti-slop` skill bundle (`skills/install-anti-slop`) of that commit, copied with its `scripts/install.mjs`.
- Installed plugin entry points: `index.ts` (generic rules). The optional `effect/` plugin is copied but not registered; this repository has no `effect` dependency.
- Local deviations: none. Contents are byte-identical to the bundle.
- `vendor/eslint-stylistic/` keeps its own `UPSTREAM.md` and `LICENSE`.

Rule severities live in the repository's `.oxlintrc.json`; local severity choices are not deviations of this copy.
