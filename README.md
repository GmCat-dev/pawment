# Pawment

**Self-hosted, watch-only crypto checkout.** Buyers pay straight into your own wallet. Pawment only watches the
blockchain, ties each payment to its order and tells your site with a signed message. It holds no keys that can spend
and runs no blockchain node.

> **Beta software, still under development.** Pawment works and is tested, but it may have bugs, and its features,
> settings and API may change between versions. Check payments in your own wallet too, and test with small amounts
> before relying on it. Provided "as is", without warranty (see the licence).

**Live demo (pretend money):** https://pawment.gmcat.io

## What it accepts
- **Cardano:** ADA and any Cardano token (USDCx, USDM, USDA, DJED, iUSD built in; add others from the dashboard)
- **Bitcoin family:** BTC, LTC, BCH, GRS (Groestlcoin)
- **Ethereum, BNB Smart Chain, Polygon:** ETH, BNB, POL, plus USDT and USDC on each
- **TRON:** TRX, USDT
- **Monero:** XMR

## How it works
1. Your site creates an order with one API call (amount in US dollars) and sends the buyer to the checkout link.
2. The buyer picks a coin. The price is held for 30 minutes. They pay with a wallet button, a QR code or by copying the address.
3. Pawment sees the payment, waits for enough confirmations, double-checks it with a second blockchain service, and
   tells your site (`order.paid`, signed with your webhook secret).

Where possible each order gets a **fresh address** made from your wallet's public key (Bitcoin family, Cardano,
Monero). Chains that use one address per wallet (Ethereum family, TRON) tell orders apart by a tiny unique amount
(at most about a cent).

Small differences are forgiven (1.5% by default). An underpaid order stays open for the rest; an overpaid one
completes and the extra is listed for a refund. A payment up to 24 hours late still counts at the held price. Anything
odd goes to a **Needs you** list in the dashboard instead of being guessed.

Refunds are sent **by you**, from your own wallet: the buyer asks on their receipt page and gives an address, and
Pawment sees your refund arrive on the blockchain and marks it done.

## Quick start (test network)
Needs Node.js 22.13 or newer. No other services.

    git clone https://github.com/GmCat-dev/pawment && cd pawment
    npm install                       # optional: only for the Cardano wallet "Pay" button; everything else needs no packages
    cp settings.example.json settings.json   # then set "network": "testnet" and "public_url"
    node cli.mjs init                 # admin key -> data/admin-key.txt
    echo 'a long password' | node cli.mjs password
    node cli.mjs add-site myshop      # site API key + webhook secret -> data/site-myshop.txt
    npm start                         # http://127.0.0.1:4197/admin/

Try every screen without any real coins:

    PAY_SIM=1 PAY_DATA=/tmp/paysim npm start      # pretend blockchain (test network only)
    node demo/host.mjs                            # the live demo host, one sandbox per visitor (port 4202)

Run the tests: `npm test`.

For a real server (Nginx, HTTPS, systemd), follow **[docs/INSTALL.md](docs/INSTALL.md)**.

## Docs
- [docs/INSTALL.md](docs/INSTALL.md): install on a server, step by step
- [docs/WALLETS.md](docs/WALLETS.md): which public key or address to give for each coin, and where to find it
- [docs/API.md](docs/API.md): the site API and the signed notices
- [docs/SETTINGS.md](docs/SETTINGS.md): every setting
- [SECURITY.md](SECURITY.md): reporting a problem, and how Pawment is kept safe

## Layout
- `core/`: engine (orders, quotes, address pool, matching, refunds, notices), settings, prices, small crypto helpers
- `chains/`: one plug-in per blockchain family (Cardano, Bitcoin family over Electrum, EVM, TRON, Monero)
- `public/`: the buyer checkout and receipt page (`/o/<order id>`) and the owner dashboard (`/admin/`)
- `app.mjs`: one complete instance; `server.mjs` runs it; `demo/` runs many small sandboxes for the live demo
- `cli.mjs`: set-up helper (secrets go to files in `data/`, readable only by you, never printed)

## Licence
Free under the **GNU AGPL-3.0** ([LICENSE](LICENSE)). If you'd rather not share your changes with your users, a
commercial licence is available: see [COMMERCIAL.md](COMMERCIAL.md). Credits for code and data from other projects are
in [NOTICE.md](NOTICE.md).

The Pawment name and logo, and the GmCat name, wordmark and artwork on the demo page, belong to GmCat (not covered by the code licence). Pawment is made by [GmCat](https://gmcat.io).
