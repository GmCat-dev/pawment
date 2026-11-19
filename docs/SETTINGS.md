# Settings

> **Beta software, still under development.** Setting names may change between versions.

`settings.json` (path in `PAY_SETTINGS`) holds everything that isn't secret. Most of it can be changed in the dashboard,
which saves this file. Start from `settings.example.json`.

| Setting | Default | Meaning |
|---|---|---|
| `name` | `"Pawment"` | Your shop's name on the checkout and in alert emails |
| `public_url` | | The address buyers use, e.g. `https://pay.example.com` (checkout links are built from it) |
| `network` | `"mainnet"` | `"testnet"` for test networks (see WALLETS.md); needs a restart to change |
| `brand.logo` | `""` | Logo image (a path under `public/` or a full URL) |
| `brand.accent` | `"#6b4fd8"` | Accent colour |
| `brand.theme` | `""` | A stylesheet in `public/themes/` (file name without `.css`) to restyle the checkout and dashboard |
| `brand.support_url`, `terms_url`, `privacy_url` | `""` | Links in the checkout footer |
| `quote_minutes` | `30` | How long a coin price is held once the buyer picks a coin |
| `grace_hours` | `24` | A payment this late still completes at the held price |
| `order_hours` | `72` | An order nobody starts paying closes after this long |
| `tolerance_percent` | `1.5` | Paid within this much of the price counts as paid |
| `refund_days` | `7` | How long after paying a buyer can ask for a refund |
| `gap_budget` | `15` | Most unused fresh addresses out at once (keep below 19) |
| `featured` | `""` | Coin shown first and pre-selected |
| `coins` | | The coin list: id, chain, unit, decimals, price sources, `enabled`, optional `discount` (with `from`/`until` dates and a `badge`) and `min_usd` |
| `sites` | `{}` | Per-site name, notify/return URLs, and overrides (`featured`, per-coin `enabled`/`discount`) |
| `email_alerts` | | `to` and `from` for owner alerts (sending needs a Resend key, set in the dashboard) |
| `analytics_origin` | `""` | Optional: one outside script origin (e.g. a privacy-friendly page counter) allowed on the home page only (`public/home/index.html`, if you add one). Checkout and dashboard never load outside scripts |
| `coming_soon` | `false` | Show a "coming soon" page; checkout and dashboard then need a preview code |

## Secrets (never in settings.json)
In `PAY_DATA` (default `./data`), readable only by the service user, set with `cli.mjs` or the dashboard:
- `secrets.json`: dashboard password hash, admin key hash, per-site API key hashes and webhook secrets
- optional key files: Resend (alert emails), Blockfrost project id and Koios token (Cardano data), preview code hash

## Environment variables
`PAY_DATA`, `PAY_SETTINGS`, `PAY_PORT` (default 4197), `PAY_HOST` (default 127.0.0.1), `PAY_SWEEP_EVERY` (seconds
between blockchain checks, default 20), `PAY_SIM=1` (pretend blockchain, test network only).
