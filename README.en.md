# dsh-token-fee

[![CI](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml/badge.svg)](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.md) | English | [Docs](docs/README.md)

Live **per-session cost** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI (`dsh web`).

A cost pill appears under the composer: it shows the current session's spend in CNY by default, rounded to the cent. Clicking it opens a panel that lists, per provider and model, the token counts and amounts for **cache misses, cache hits, cache writes and output**, and lets you edit the pricing table in place.

> Built and verified against DSH `0.1.7-rc.1`, compatible with every release from `0.1.5-rc.1` onwards, with the contract check extended through **`0.2.1-rc.2`** (`0.1.7-rc.2`, `0.2.0-rc.1`, `0.2.0-rc.2`, plus `alpha.1`–`alpha.5`, `rc.1` and `rc.2` of the 0.2.1 line, audited one by one). The 0.2.1 line adds two **visual** boundaries (the official stats pills split into two dock entries, and the pill corner radius went from fully round to 8px); every contract surface this plugin relies on is unchanged — see [`docs/dsh-integration.md`](docs/dsh-integration.md). On `0.1.6-alpha.1` the pill and the stats pills stack instead of sharing a row.

## Features

| | Capability |
| --- | --- |
| 💰 | Live session cost, to the cent, with a configurable display currency |
| 🧾 | Usage and cost breakdown grouped by provider / model |
| 🏷️ | **Per-provider pricing**: the same model can carry completely different unit prices under different providers |
| 🕘 | **Peak/off-peak pricing**: two unit-price tiers with a rule you control (timezone, peak weekdays, peak windows); the pill shows the current period and the time left until the next switch |
| ⚙️ | A pricing panel, both as its own page in dsh settings and straight from the cost panel |
| 📄 | The table lives in `<DSH_HOME>/token-fee.json`; editing it by hand takes effect immediately, with no restart |
| 🌐 | Bilingual UI (Chinese and English) |

## Install

Pick any one of the three. Afterwards **restart `dsh web`, then hard-refresh the browser**.

### Plugin manager (DSH `0.1.6-alpha.2` onwards)

Sidebar → **Plugins** → **Add plugin**, and put any of these in "Package or address":

| Form | What to enter |
| --- | --- |
| npm package name | `@lantiosity/dsh-token-fee` |
| GitHub shorthand | `github:lantiosity/dsh-token-fee` |
| Repository URL | `https://github.com/lantiosity/dsh-token-fee` |
| Local checkout | The absolute path to this repository |

Click **Install**: the Host first reads what the spec names and only then installs, once it confirms a plugin carrying `dsh.bundle.patch`. When it finishes, **Enable now** switches the plugin on and scrolls the list to it.

- The registry defaults to pnpm's own; mainland China can switch to npmmirror. A **package name** is resolved through whichever registry is selected, so a mirror works there; a **repository URL** is not — a mirror only supplies registry packages and their dependencies, not the GitHub repository itself, so that path still goes straight to GitHub and switching mirrors does not help when GitHub is unreachable.
- A successful installation does not certify that the module can activate. If no cost pill appears after the restart, check dsh's startup log.

### Command line

```bash
# From npm
dsh plugin --profile web add "@lantiosity/dsh-token-fee"

# From GitHub
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"

# Or from a local checkout (point the path at this repository)
dsh plugin --profile web add "/path/to/dsh-token-fee"
```

### Fallback installer

When `dsh plugin` is unavailable:

```bash
node scripts/install.mjs            # copy files and idempotently write the profile patch
node scripts/install.mjs --dry-run  # print the paths that would be written
node scripts/install.mjs --check    # verify an existing installation
```

All three paths merge the host half into the profile's bundle layer — this package declares `dsh.bundle.patch`, so you do **not** need to edit the profile's `cordis.patch.yml` by hand.

## Usage

- **Cost pill**: sits under the composer beside the built-in "turns / speed" and "token usage" pills. It shows an amount such as `¥0.12`; when the session also contains models with no configured price, it notes how many.
- **Billing mode**: the amount is followed by the billing mode of the model currently in use. A single unit price shows `· 计费模式：统一`; with an off-peak price configured it shows `· 计费模式：峰谷 · 当前时段：高峰 · 剩余时间：01:22:32`, where the countdown refreshes every second down to the next period switch. The mode comes from the latest request's route in the projection, so switching models updates it immediately.
- **Cost breakdown**: opened by clicking the pill. The total sits at the top, followed by groups per provider; **each model shows only its total token count and cost until you click it**, which reveals the token count and amount for each of the four billing buckets. Entries with peak/off-peak pricing are marked "Peak/off-peak". Warning badges (usage without a period, no matching entry) stay visible while collapsed, because they bear on whether the bill is right and should not hide behind a click.
- **Subagent usage**: subagents this session calls (including nested ones) run in their own sessions, so their usage is not on this session's bill by default. The plugin **counts them into the total** and gives them their own group in the breakdown: one row per subagent with its label, total tokens and cost, expanding to that subagent's own provider/model detail. When any are present the total is labelled "Total (incl. subagents)". If a subagent's usage cannot be read at that moment, the panel says how many were left out rather than treating them as zero. **Known limitation**: backends running outside DSH (ACP, Codex, Claude Code, …) produce no DSH session log, so their tokens cannot be read at all and such subagents can only show 0.
- **Pricing**: the panel's second tab, or the "Token fee" page in dsh settings.

## Pricing configuration

### Storage and precedence

The pricing table is merged from three layers, **each overriding the previous one**:

1. Built-in layer: DeepSeek's official pricing — one entry per model (`deepseek-flash`, `deepseek-v4-pro`), two in total; **one entry covers both `deepseek-official` and `deepseek-account`** (the account route matches the same entry through the provider alias);
2. User file layer: `<DSH_HOME>/token-fee.json`;
3. Plugin config layer: the `pricing` / `schedules` fields of the cordis config.

The plugin deliberately ships **no** pricing for other providers: the same model costs different amounts through a reseller, an aggregator or a self-hosted proxy, and passing official prices off as theirs produces a wrong bill. Add your own entries for every other provider.

### Plugin config (cordis.yml)

The entry's `config` in `cordis.yml` accepts five keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `displayCurrency` | `CNY` | Display currency for the pill and the total; must be an ISO 4217 code ICU recognizes. |
| `exchangeRates` | none | Conversion rates `{ currency: number }`, meaning one unit of that currency equals how many units of the display currency, for example `{ USD: 7.2 }`. **Normally written in `token-fee.json`** (applies as soon as you save); the copy here is the administrator override. |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | Path to the user pricing table; a relative path resolves against `DSH_HOME`. |
| `schedules` | none | Extra or overriding named peak/off-peak schedules. |
| `pricing` | none | Extra or overriding pricing entries. |

Config is validated **at load time**: unknown keys, a misspelled currency and structurally invalid entries all make the plugin end up FAILED rather than being silently ignored — a misconfiguration should be noticed immediately.

```yaml
- id: token-fee
  config:
    displayCurrency: CNY
    pricingFile: my-prices.json
```

**Rates live in `token-fee.json`** (the "File format" section of [`docs/configuration.md`](docs/configuration.md) has the full example):

```json
{
  "version": 1,
  "exchangeRates": { "USD": 7.2 },
  "entries": []
}
```

The file is read by mtime, so **no dsh restart is needed**: opening the pricing page refetches, and the pill picks the new values up on a page refresh. `exchangeRates` in `cordis.yml` still works as the administrator override — the config value wins per currency, and currencies it omits fall back to the file. Saving the price table from the settings page carries the file's rates back, so it never wipes them.

**Multiple currencies**: every pricing entry carries its own `currency`, so one session can mix CNY and USD usage. The pill and the total **always** accumulate per currency side by side (`¥1.23 + US$0.56`) and never drop one; once `exchangeRates` is configured they additionally show one converted total (`≈ ¥5.26`). **If any foreign currency has no rate, no converted total is shown at all** — half a total is more dangerous than none. Details in [`docs/configuration.md`](docs/configuration.md).

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

| Field | Meaning |
| --- | --- |
| `provider` | Route provider id, for example `deepseek-official` or your own reseller id. `*` is a wildcard. |
| `model` | Model id, for example `deepseek-flash`. `*` is a wildcard. |
| `currency` | Three-letter currency code deciding the displayed currency of the amount. |
| `schedule` | A name from `schedules`, an inline schedule object, or `null` for a flat price. |
| `prices.peak` | Peak (or sole) unit price, **per million tokens**. |
| `prices.offPeak` | Off-peak unit price; requires a `schedule` when present. |
| `cacheWrite` | Treated as 0 when omitted. |

### Matching rules

Entries match on `(provider, model)`, highest priority first: **exact → provider wildcard → model wildcard → full wildcard**; within one priority the earliest entry wins.

A model that matches no entry still shows its token counts, but its amount is marked as unpriced and is **excluded from the total**.

The built-in pricing covers both of DSH's DeepSeek routes: `deepseek-official` (API key) and **`deepseek-account`** ("DeepSeek Account", an account token). They share one model catalog, and the account side also falls back through retired model names.

### Peak/off-peak schedules

A `schedule` describes the peak window:

| Field | Meaning |
| --- | --- |
| `timezone` | IANA timezone name, for example `Asia/Shanghai`. |
| `peakDays` | Peak weekdays, `0` being Sunday. |
| `peakWindows` | Peak windows, half-open `["HH:MM", "HH:MM"]` intervals. |
| `holidays` | A holiday set name or date array; those dates are **not peak**, even on a peak weekday. |
| `workdays` | A make-up-workday set name or date array; those dates **are peak**, even off a peak weekday. Not set by default. |

The plugin ships one schedule named `deepseek` (Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00, **public holidays excluded**, **and make-up workdays on weekends priced as off-peak too**). Define a schedule of the same name in the user file's `schedules` to override it, or add your own for entries to reference — the built-in pricing entries reference the schedule **name** rather than an inlined copy, so your override applies to the built-in entries too.

**Mainland China public holidays ship with the package** in `data/cn-holidays.json` (dates taken from the [State Council's annual holiday notice](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)). The built-in `deepseek` schedule references its `cn` set, so the official "public holidays excluded" rule applies by default. A rule card's "Public holidays" dropdown lets your own schedules use the same set.

> Official pricing: **make-up workdays on weekends are not peak**, so when matching the official rate do not attach `workdays` to the `deepseek` schedule. `workdays` is a general switch for providers that do charge peak on make-up weekends.

> Editor behaviour (suggestions, numeric drafts and zeroing, the pre-save blocks, rule cards and renaming, the split hour/minute inputs, and more) is documented in [`docs/configuration.md`](docs/configuration.md).

## Built-in pricing

| Model | Tariff | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | Peak | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | Off-peak | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | Peak | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | Off-peak | ¥0.15 | ¥4.5 | ¥13.5 |

All figures are CNY per million tokens, taken from DeepSeek's official pricing page. **One entry per model, covering both `deepseek-official` (API key) and `deepseek-account` ("DeepSeek Account", an account token)** — they cost the same and the account route matches the same entry through the provider alias, so the list holds one entry rather than two. To price the account route separately, add an entry with `provider: "deepseek-account"` (an exact match beats the alias).

## Known limitations

- **The endpoints are unavailable over a remote address**: the pricing endpoints accept loopback origins only. Reaching the GUI over a remote address such as Tailscale makes reads and writes return 403 and the panel show everything as unpriced. Edit `<DSH_HOME>/token-fee.json` directly instead.
- **The holiday data needs updating every year**: `data/cn-holidays.json` currently covers 2026 only (the State Council's notice for a new year usually lands in the previous November). A year with no data falls back to the natural-weekday decision, so that year's public holidays count as peak.
- **Cross-currency**: every currency is **always accumulated and shown side by side**, never dropped; folding them into a single total needs `exchangeRates` from you — the plugin makes no outbound requests and will not hard-code a rate that goes stale. A currency without a rate cannot enter the converted total and is named in the breakdown.
- **The countdown does not carry hours into days**: a long gap across a weekend is shown as total hours (for example `63:00:00`).

> Why these limitations exist, and the design trade-offs behind them, are in [`docs/internals.md`](docs/internals.md).

## Development

```bash
npm run check         # syntax check
npm test              # the three offline suites
npm run test:process  # process-level regression: install into a real dsh web via a --patch overlay and probe the endpoints
npm run verify        # the three above, in order (what CI runs)
```

There is no build step; `lib/*.js` is the shipped artifact. The test suites, code structure and documentation index are in [`docs/development.md`](docs/development.md).

## License

MIT, see [`LICENSE`](LICENSE).
