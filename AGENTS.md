# AGENTS.md

Maintenance rules for agents and maintainers working in this repo. Product documentation
lives in `README.md` and `docs/`; this file only records what is easy to break.

## Do not change

- **The `dsh-plugin` GitHub topic**: dsh-plugin.org discovers and lists this plugin through
  that topic, so dropping it removes the plugin from the marketplace. **Editing topics
  replaces the whole list**:

  ```sh
  gh api -X PUT repos/lantiosity/dsh-token-fee/topics \
    -f 'names[]=deepseek-harness' \
    -f 'names[]=deepseek-harness-plugin' \
    -f 'names[]=deepseek-harness-plugins' \
    -f 'names[]=dsh-plugin' \
    -f 'names[]=dsh-plugins'
  ```

  Always re-check afterwards: `gh api repos/lantiosity/dsh-token-fee --jq '.topics|join(",")'`.
  Shipping a release or changing code **never** requires touching the topics — so don't.

- **The install commands in the README**: listing requirements expect one of the form
  `dsh plugin --profile web add "@lantiosity/dsh-token-fee"`. Keep that form when editing
  the install section (the source-install and local-path variants must stay too).

- **`name` and `version` in the root `package.json`**: the marketplace matches installed
  plugins by package name, so renaming the package effectively creates a different plugin.

## Releasing

1. `npm run verify`: all four suites must be green (pricing, host, client, process-level).
   Never ship with a single red.
2. Bump `version` in `package.json` and write `docs/release-notes/vX.Y.Z.md` (one file, both
   languages; the GitHub Release body is that file — skipping it leaves wrong numbers in
   public artifacts).
3. `git commit -m "chore(release): vX.Y.Z"` → push main → annotated tag → `gh release create`.
4. `npm publish --registry https://registry.npmjs.org` **needs a human 2FA step**: an agent
   run fails with `EOTP`/`E404`, so hand the command to the maintainer and verify
   `dist-tags`, file count and shasum afterwards.

## Invariants

- **The host half and the browser half must stay isomorphic**: `lib/pricing.js` and
  `lib/client.js` each carry their own `nextTariffBoundary` / `tariffStateAt`, so changing
  one requires changing the other — otherwise the pill points at the wrong switch instant
  (a hard-coded 8-day cap once dropped the countdown entirely).
- **Aggregation, sorting and collapsing are display-only**: the underlying array order
  decides wildcard tie priority.
- **Gate discipline**: when adding or changing a test, first break the implementation and
  confirm the test goes red, then restore. Otherwise you don't know the test tests anything
  (this repo has had both a tautological assertion and a patch too weak to bite).
- **Quantified claims in the panel and release notes come from a real measurement**, never
  from arithmetic on day counts.
