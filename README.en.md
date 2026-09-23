# dsh-token-fee

[![CI](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml/badge.svg)](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文](README.md) | English | [Docs](docs/README.md)

Live **per-session cost** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI (`dsh web`).

A cost pill appears under the composer: it shows the current session's spend in CNY by default, rounded to the cent. Clicking it opens a panel that lists, per provider and model, the token counts and amounts for **cache misses, cache hits, cache writes and output**, and lets you edit the pricing table in place.

> Built and verified against DSH `0.1.7-rc.1`, compatible with every release from `0.1.5-rc.1` onwards (on `0.1.6-alpha.1` the pill and the stats pills stack instead of sharing a row). The compatibility check is in [`docs/dsh-integration.md`](docs/dsh-integration.md).

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

The standard path (requires `pnpm`):

```bash
# From GitHub
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"

# Or from a local checkout (point the path at this repository)
dsh plugin --profile web add "/path/to/dsh-token-fee"
```

This package declares `dsh.bundle.patch`, so dsh merges it into the profile's bundle layer and you do **not** need to edit the profile's `cordis.patch.yml` by hand.

When `dsh plugin` is unavailable, there is a fallback installer:

```bash
node scripts/install.mjs            # copy files and idempotently write the profile patch
node scripts/install.mjs --dry-run  # print the paths that would be written
node scripts/install.mjs --check    # verify an existing installation
```

Only one of the two paths is needed. Afterwards **restart `dsh web`, then hard-refresh the browser**.

## Usage

- **Cost pill**: sits under the composer beside the built-in "turns / speed" and "token usage" pills. It shows an amount such as `¥0.12`; when the session also contains models with no configured price, it notes how many.
- **Billing mode**: the amount is followed by the billing mode of the model currently in use. A single unit price shows `· 计费模式：统一`; with an off-peak price configured it shows `· 计费模式：峰谷 · 当前时段：高峰 · 剩余时间：01:22:32`, where the countdown refreshes every second down to the next period switch. The mode comes from the latest request's route in the projection, so switching models updates it immediately.
- **Cost breakdown**: opened by clicking the pill. The total sits at the top, followed by groups per provider listing each model's token counts and amounts across the four billing buckets. Entries with peak/off-peak pricing are marked "Peak/off-peak".
- **Pricing**: the panel's second tab, or the "Token fee" page in dsh settings.

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

Config is validated **at load time**: unknown keys, a misspelled currency and structurally invalid entries all make the plugin end up FAILED rather than being silently ignored — a misconfiguration should be noticed immediately.

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

### Peak/off-peak schedules

A `schedule` describes the peak window:

| Field | Meaning |
| --- | --- |
| `timezone` | IANA timezone name, for example `Asia/Shanghai`. |
| `peakDays` | Peak weekdays, `0` being Sunday. |
| `peakWindows` | Peak windows, half-open `["HH:MM", "HH:MM"]` intervals. |

The plugin ships one schedule named `deepseek` (Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00). Define a schedule of the same name in the user file's `schedules` to override it, or add your own for entries to reference — the built-in pricing entries reference the schedule **name** rather than an inlined copy, so your override applies to the built-in entries too.

> Editor behaviour (suggestions, numeric drafts and zeroing, the pre-save blocks, rule cards and renaming, the split hour/minute inputs, and more) is documented in [`docs/configuration.md`](docs/configuration.md).

## Built-in pricing

| Model | Tariff | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | Peak | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | Off-peak | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | Peak | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | Off-peak | ¥0.15 | ¥4.5 | ¥13.5 |

All figures are CNY per million tokens, taken from DeepSeek's official pricing page, and apply to the `deepseek-official` route only.

## Known limitations

- **The endpoints are unavailable over a remote address**: the pricing endpoints accept loopback origins only. Reaching the GUI over a remote address such as Tailscale makes reads and writes return 403 and the panel show everything as unpriced. Edit `<DSH_HOME>/token-fee.json` directly instead.
- **Chinese public holidays**: the official peak decision excludes public holidays, while this plugin decides by natural weekdays, so holidays are overpriced as peak. For exact billing, adjust the schedule for those days or use a flat price.
- **Cross-currency**: amounts in different currencies are not converted or merged. The pill and the total count the display currency only; other currencies are reported separately in the breakdown.
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
