# dsh-token-fee

[![CI](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml/badge.svg)](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

English | [中文](README.md)

Real-time per-session token cost for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI (`dsh web`).

A cost pill appears under the composer, showing the current session's cost in CNY by default, rounded to the cent. Clicking it opens a panel that lists token counts and amounts for four buckets — **cache miss, cache hit, cache write and output** — grouped by provider and model, and lets you edit the pricing table in place.

> Built and verified against DSH `0.1.7-rc.1`, compatible with every release from `0.1.5-rc.1` onwards (on `0.1.6-alpha.1` the pill and the stats pills stack instead of sharing a row).

## Features

| | Capability |
| --- | --- |
| 💰 | Live session cost, rounded to the cent, with a configurable display currency |
| 🧾 | Usage and cost breakdown grouped by provider and model |
| 🏷️ | **Per-provider pricing**: the same model can carry a completely different unit price under each provider |
| 🕘 | **Peak/off-peak pricing**: separate peak and off-peak unit prices, with user-defined rules (timezone, peak weekdays, peak windows); the pill shows the current period and the time left until the next change |
| ⚙️ | Pricing editor: a dedicated page in dsh settings, also reachable from the cost panel |
| 📄 | Pricing table lives at `<DSH_HOME>/token-fee.json`; hand edits apply immediately without a restart |
| 🌐 | Bilingual UI (Chinese and English) |

## Install

Standard install path (requires `pnpm`):

```bash
# Install from GitHub
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"

# Or install from a local checkout (replace the path with this repository's directory)
dsh plugin --profile web add "/path/to/dsh-token-fee"
```

This package declares `dsh.bundle.patch`, so dsh folds it into the profile's bundle layer; editing the profile's `cordis.patch.yml` by hand is **not** needed.

When `dsh plugin` is unavailable, use the fallback installer:

```bash
node scripts/install.mjs            # copy files and idempotently write the profile patch
node scripts/install.mjs --dry-run  # print the paths that would be written
node scripts/install.mjs --check    # verify an existing install
```

Use only one of the two paths. Afterwards, **restart `dsh web` and hard-refresh the browser**.

## Usage

- **Cost pill**: sits under the composer, next to the built-in "turns / speed" and "token usage" pills. It shows an amount such as `¥0.12`; when the session still has models without a matching price, it also reports how many are unpriced.
- **Billing mode**: after the amount, the pill shows how the model in use right now is billed. A single unit price gives `· Billing: flat`; an entry with off-peak prices gives `· Billing: peak/off-peak · Period: peak · Left: 01:22:32`, where the countdown ticks every second down to the next period change. The mode comes from the projection's most recent request route, so it follows a model switch immediately.
- **Cost breakdown**: opens on click. The total is on top; below it, each provider is a group and each model lists the four billing buckets with token counts and amounts. Entries with peak/off-peak prices are tagged accordingly.
- **Pricing**: the panel's second tab, or the "Token cost" page in dsh settings.

## Pricing configuration

### Storage and precedence

The pricing table is merged from three layers, **each overriding the previous one**:

1. Built-in layer: only the DeepSeek official route `deepseek-official` with its peak/off-peak rules;
2. User file layer: `<DSH_HOME>/token-fee.json`;
3. Plugin config layer: the `pricing` / `schedules` fields of the cordis config.

The plugin deliberately ships **no** pricing for other providers: the same model costs different amounts through a reseller, an aggregator or a self-hosted proxy, and passing official prices off as theirs produces a wrong bill. Add your own entries for every other provider.

### Plugin config (cordis.yml)

The entry's `config` in `cordis.yml` accepts four keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `displayCurrency` | `CNY` | Display currency for the pill and the total; must be an ISO 4217 code ICU recognizes. |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | Path to the user pricing table; a relative path resolves against `DSH_HOME`. |
| `schedules` | none | Extra or overriding named peak/off-peak schedules. |
| `pricing` | none | Extra or overriding pricing entries. |

Config is validated **at load time**: unknown keys, a misspelled currency and structurally invalid entries all make the plugin end up FAILED rather than being silently ignored — a misconfiguration should be noticed immediately. Cross-field rules (an entry referencing a schedule name that does not exist) fail at load time too.

```yaml
- id: token-fee
  config:
    displayCurrency: USD
    pricingFile: my-prices.json
```

### File format

```json
{
  "version": 1,
  "schedules": {
    "my-peak": {
      "timezone": "Asia/Shanghai",
      "peakDays": [1, 2, 3, 4, 5],
      "peakWindows": [["09:00", "12:00"], ["14:00", "18:00"]]
    }
  },
  "entries": [
    {
      "id": "my-gateway-flash",
      "provider": "my-gateway",
      "model": "deepseek-flash",
      "currency": "CNY",
      "schedule": "my-peak",
      "prices": {
        "peak": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
        "offPeak": { "input": 1, "cacheRead": 0.02, "cacheWrite": 0, "output": 4 }
      }
    }
  ]
}
```

Field reference:

| Field | Meaning |
| --- | --- |
| `provider` | Route provider id, for example `deepseek-official` or your own reseller id. `*` is a wildcard. |
| `model` | Model id, for example `deepseek-flash`. `*` is a wildcard. |
| `currency` | Three-letter currency code deciding the displayed currency of the amount. |
| `schedule` | A name from `schedules`, an inline schedule object, or `null` for a flat price. |
| `prices.peak` | Peak (or sole) unit price, **per million tokens**. |
| `prices.offPeak` | Off-peak unit price; requires a `schedule` when present. |
| `cacheWrite` | Treated as 0 when omitted. |

In the editor, `provider` and `model` are free-text fields with a suggestion list drawn from the **current dsh configuration** (`ctx.llm`'s registered routes and models): `provider` lists every configured route, and `model` narrows to the models of that route once `provider` matches, falling back to all models when it does not. Suggestions are a convenience only — adapters accept model ids that are not listed, so input stays unrestricted.

Unit prices are edited as string drafts and converted to numbers only on save: `Number("1.")` yields `1`, so converting while typing would swallow the decimal point and make decimals impossible to enter.

Inputs that cannot be parsed, or that are negative, are **written as 0** on save with a note listing the corrected fields, instead of failing the whole save — the pricing table is maintained by hand, and one typo should not take every other edit down with it. The field turns red the moment the value is wrong, with an explanation on hover. To have the host reject such input outright, edit the file by hand: endpoint validation is fail-loud.

Before saving, the client also blocks three states that the UI can construct but the host would necessarily reject, each with a localized message: deleting every entry, an entry with no model id, and an entry with peak/off-peak prices but no schedule selected.

An entry's reference to a named schedule (a name in `schedules`) survives editing round-trips verbatim: the GET endpoint returns both the normalized and the raw layer, and the editor draft uses the raw one, so editing a rule still propagates to every entry referencing it.

The entry form's "Tariff schedule" dropdown is always enabled: picking a rule turns peak/off-peak on (the off-peak prices start as a copy of the peak ones, so you only edit the tier you care about), and picking "Flat price" clears both the off-peak prices and the reference. A rule added in the schedules section does **not** have to be referenced by an entry first — building the rule and attaching it afterwards is the natural order, so an unreferenced rule is written to the file as-is; deletion happens only through the ✕ on the rule card.

Rule cards mirror entry cards: collapsed by default into "name + one-line summary (timezone · peak weekdays · peak windows) + Edit", expanding on Edit and collapsing on Done. A custom rule's name is edited in place at the title, committed on blur or Enter; renaming updates every entry that references it, while an empty or duplicate name is flagged in place and reverts.

A rule whose name exists in the built-in table is always a "Built-in" rule: no rename, no delete button, even once you have overridden it (then it reads "Built-in · overridden" and gains a "Restore built-in" button). That is deliberate — the built-in entries reference `deepseek` by name, so letting that override be renamed would silently drop the built-in entries back to the factory rule while you thought you had only renamed something.

Deleting a rule that entries still reference clears those references but keeps the off-peak prices, and saving reports that a rule must be picked again; silently discarding prices the user typed would hurt more than re-picking a rule.

### Matching rules

Entries match on `(provider, model)`, highest priority first: **exact → provider wildcard → model wildcard → full wildcard**; within one priority the earliest entry wins.

The historical route id `deepseek` falls back to `deepseek-official`, and the retired model names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` fall back to `deepseek-flash`.

A model that matches no entry still shows its token counts, but its amount is marked as unpriced and is **excluded from the total**.

### Peak/off-peak schedules

A `schedule` describes the peak window:

| Field | Meaning |
| --- | --- |
| `timezone` | IANA timezone name, for example `Asia/Shanghai`. The editor's dropdown is ordered by current UTC offset, ties broken by name with `UTC` first. |
| `peakDays` | Peak weekdays, `0` being Sunday. |
| `peakWindows` | Peak windows, half-open `["HH:MM", "HH:MM"]` intervals. |

In the UI each peak window is entered as two narrow fields per clock, digits only: a two-digit value out of range (`25` hours, `61` minutes) keeps only the last digit, so an impossible time cannot be typed at all, while an unpadded intermediate (`9:5`) is padded to `09:05` on save. A row that does not end after it starts is flagged in place and blocked before saving.

The plugin ships one schedule named `deepseek` (Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00). Define a schedule of the same name in the user file's `schedules` to override it, or add your own for entries to reference.

You can also edit that built-in rule directly in the UI: the built-in pricing entries reference the schedule **name** `deepseek` rather than an inlined copy of the rule, so your override applies to the built-in entries too — when the official peak windows change, one edit is enough. The built-in rule card has no delete button (it can always be overridden); custom rule cards do.

## Built-in pricing

| Model | Tariff | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | Peak | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | Off-peak | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | Peak | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | Off-peak | ¥0.15 | ¥4.5 | ¥13.5 |

All figures are CNY per million tokens, sourced from DeepSeek's official pricing page, and apply only to the `deepseek-official` route.

## Limitations

- **The pill shares a row with the built-in stats pills**: since 0.1.6-alpha.2 `conversation.composer.dock` is a single flex row (`.dock`), and every slot occupant is a direct child of it — spacing, centering and the top pad belong to the dock. The plugin therefore only makes its own root a shrink-wrapping node matching the built-in `StatsPills.root` (no width, no padding) and never rewrites the InputBar layout: turning a row into a column, or the reverse, means rewriting the parent that carries other occupants, and a dock structure change would deform the composer — a destructive failure, not a degradation.
- **Every translucent menu surface follows the built-in frosted-glass material**: from 0.1.7-alpha.1 `--dsw-specific-menu` changed from the opaque `var(--dsw-alias-bg-layer-3)` to a translucent colour (0.5 dark / 0.58 light). The built-in contract is that an elevated surface painting that fill **also** applies `backdrop-filter: var(--dsw-menu-backdrop-filter)` (`blur(40px) saturate(150%)`) — painting the fill alone leaves a pane you can see the page through. The panel and the sticky save bar (which content scrolls beneath) both follow that pairing. 0.1.6-alpha.2 and earlier have no such variable, so the declaration is invalid at computed-value time and `backdrop-filter` falls back to `none`, which is exactly the degradation needed there (the fill is opaque); no version branch is required. `test-client.mjs` asserts the pairing on **every** rule that paints that fill.
- **Every design token is checked individually**: each `--dsw-*` the plugin references was confirmed to exist in DSH's `ui-theme`/`ui-primitives`. Referencing an undefined custom property invalidates the **whole declaration** at computed-value time: the `--dsw-alias-fill-l1`/`-l2` and `--dsw-alias-separator-primary` this plugin used to name were never defined by DSH, and `--dsw-alias-state-warning-primary` was a typo for `--dsw-alias-state-warn-primary`, so selected-tab fills, badge fills and the separator colour were all silently dropped. `test-client.mjs` freezes that allowlist.
- **Built-in icons are resolved by which name exists**: `ui-primitives` renamed its icons once — 0.1.5-rc.1 through 0.1.6-alpha.2 spelled the size into the name (`IconDatabaseOutline16`), while 0.1.7-alpha.1 onwards spells the weight (`IconDatabaseOutlineRegular`/`Medium`). The plugin tries both namings (preferring `Regular`, which matches the old look) and degrades to drawing no icon when neither exists. **A missing icon must not take the pill down with it**: handing `undefined` to React as a component throws "Element type is invalid", which kills the whole occupant — the pill and its panel both vanish over a decorative glyph. The fallback is by availability rather than by version branch, because a browser-side plugin cannot read the DSH version.
- **The pricing endpoints accept loopback origins only**: reads and writes require the peer socket to be loopback and the `Host` header to be loopback or `localhost`. Reaching the GUI over a **remote address** such as Tailscale makes the endpoints return 403, the cost panel shows everything as unpriced, and the settings page reports the failure. This is part of the CSRF and DNS-rebinding defense: relaxing it would mean reusing the connection plugin's trust decision, which lives in a client package that a link-installed plugin cannot resolve, and re-implementing it would duplicate security-critical logic. Over a remote address, edit `<DSH_HOME>/token-fee.json` directly.
- **Chinese public holidays**: the official peak decision excludes public holidays, while this plugin decides by natural weekdays, so holidays are overpriced as peak. For exact billing, adjust the schedule for those days or use a flat price.
- **Cross-currency**: amounts in different currencies are not converted or merged. The pill and the total count only the display currency; other currencies are reported separately in the breakdown.
- **Amounts are converted in the browser**: the session projection carries only token buckets, so price edits apply immediately and never invalidate the persisted projection cache. The period split is the one piece of derived data baked into that state, and it invalidates the checkpoint through the table fingerprint in `stateVersion` (previous bullet). The cost is that host and browser each have their own conversion implementation (the browser side cannot import the host module) — the same holds for the tariff decision and the countdown; several assertions in `test-client.mjs` pin both the cost and the period results together so they cannot drift unnoticed.
- **Historical attribution**: which period a sample belongs to is decided **at fold time** from the pricing table in effect then, and written into the projection state. That state is a persisted checkpoint, so the plugin folds a content fingerprint of the effective pricing table into the projection's `stateVersion`: **editing a price, a schedule, or the entry list invalidates the checkpoint and the whole log is refolded under the new table**, so history follows the current rule instead of staying frozen at the original verdict. A sample folded while no two-tier price was available (entry not configured yet, or a single unit price only) is labelled `flat` (no peak/off-peak split), and the breakdown panel reports that usage separately as "without a period" rather than passing it off as peak.
- **The period label never defaults to peak**: the fallback used to be `peak`, so usage recorded before a price existed — or under a single unit price — was counted as peak, and once written into the checkpoint that label was frozen. That is exactly where "peak usage exceeds what the rule computes by a dozen points" came from.
- **The countdown does not roll hours into days**: long gaps such as a weekend render as total hours (`63:00:00`), which answers "how long is left" more directly than "2 days 15 hours".
- **The config schema is a hand-written Standard Schema**: the contract requires the plugin to export `Config`, and cordis only calls `Config['~standard'].validate` (`vendor/cordis/src/fiber.ts`). This plugin does not `import '@deepseek-ai/schemastery'` because it is installed by link, and Node walks up from the plugin's real path looking for `node_modules` — it cannot reach `$DSH_HOME/profiles/node_modules` (verified: `ERR_MODULE_NOT_FOUND`), so importing that package would make the plugin fail to load. The hand-written validator still reports errors at load time, fills defaults and rejects unknown keys.

## Development

```bash
npm run check         # syntax check
npm test              # the three offline suites
npm run test:process  # process-level regression: load into a real dsh web via a --patch overlay and probe the endpoints
```

| Suite | Coverage |
| --- | --- |
| `scripts/test-pricing.mjs` | Pricing validation, match priority, peak/off-peak decisions, period-change countdown, cost conversion |
| `scripts/test-host.mjs` | `apply` registrations, projection folding (replacement and retry), pricing file reads and writes, endpoint auth and Promise ownership |
| `scripts/test-client.mjs` | Module factory assembly, `apply` slot registration, real React rendering (including the pill's billing mode), and host/browser agreement on cost and period decisions |
| `scripts/test-process.mjs` | Loading into a real `dsh web` via a `--patch` overlay: endpoint contracts, failure paths, and **the process surviving an endpoint error** |

`test-client.mjs` resolves real React from `<DSH_HOME>/profiles/node_modules`, falling back to a stand-in and skipping the rendering cases when it is absent. `test-process.mjs` needs `dsh` on `PATH` and skips entirely (exit code 0) otherwise, so it is safe to run where dsh is not installed.

Source layout:

| File | Responsibility |
| --- | --- |
| `lib/pricing.js` | Pure pricing primitives: built-in table, named schedules, layered merge, entry matching, period decision and countdown, cost conversion |
| `lib/index.js` | Host half: the `tokenFee` session projection and the pricing read/write endpoints |
| `lib/client.js` | Browser half: cost pill (with billing mode and countdown), breakdown panel, pricing editor, settings page |
| `cordis.patch.yml` | Bundle-layer patch mounting the host half |
