# Site API

> **Beta software, still under development.** The API may change between versions; read the release notes before updating.

Your shop talks to Pawment from its **server** (never from the browser: the API key must stay secret).
Each site has its own API key and webhook secret (`node cli.mjs add-site <id>`, or the dashboard's **Sites** tab).

## Create an order
    POST /api/orders
    Authorization: Bearer <site API key>
    Content-Type: application/json

    {
      "amount": "24.00",
      "currency": "USD",
      "item": "Coffee beans, 1 kg",
      "ref": "order-1042",
      "notify_url": "https://shop.example.com/pawment-hook",
      "return_url": "https://shop.example.com/thanks",
      "coins": ["ADA", "BTC", "USDCpol"],
      "discounts": false
    }

| Field | Needed | Meaning |
|---|---|---|
| `amount` | yes | US dollars, 0.50 to 100000 |
| `currency` | no | only `"USD"` for now |
| `item` | no | shown to the buyer (up to 140 characters) |
| `ref` | no | your own reference (up to 120 characters) |
| `notify_url` | no | where notices go; otherwise the site's default |
| `return_url` | no | the "Back to the shop" link |
| `coins` | no | only offer these coins |
| `discounts` | no | `false` ignores per-coin discounts |

Answer (`201`):

    { "id": "ord_…", "status": "open", "checkout_url": "https://pay.example.com/o/ord_…",
      "amount": "24.00", "currency": "USD", "item": "…", "ref": "…", "test": false, "created": 1795000000,
      "paid_at": null, "payment": null, "refunded": [] }

Send the buyer to `checkout_url`. That page is also their receipt, so they can keep the link.

## Check an order
    GET /api/orders/<id>
    Authorization: Bearer <site API key>

`status` is one of:
- `open`: waiting for the buyer to pick a coin or pay
- `seen`: a payment was seen and is waiting for confirmations
- `part_paid`: paid less than the price; still open for the rest
- `paid`: done. `payment` says the coin, amount, dollars and transaction ids
- `check`: something needs the owner (for example a payment after the grace period)
- `expired` (nobody paid in time) or `cancelled`

Refunds don't change the status; they are listed in `refunded`.

Only treat an order as paid when the status is `paid`.

## Notices (webhooks)
When an order is paid or refunded, Pawment sends a `POST` to the notify URL:

    Content-Type: application/json
    Pawment-Signature: t=1795000123,v1=5f2c…

    { "event": "order.paid", "at": 1795000123, "order": { …same as GET /api/orders/<id>… } }

Events: `order.paid`, `order.refunded`. If your server doesn't answer with a 2xx status, Pawment tries again after 1 minute, 5 minutes, 30 minutes, 2, 6 and 12 hours, and 1 day.

**Check the signature** before trusting a notice: compute `HMAC-SHA256(webhook_secret, "<t>.<raw body>")` in hex and
compare it to `v1` (with a constant-time compare), and ignore notices whose `t` is more than a few minutes old.

Node.js:

    import { createHmac, timingSafeEqual } from 'node:crypto';
    function pawmentOk(rawBody, header, secret) {
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || '');
      if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
      const want = createHmac('sha256', secret).update(m[1] + '.' + rawBody).digest();
      return timingSafeEqual(want, Buffer.from(m[2], 'hex'));
    }

PHP:

    function pawment_ok($raw, $header, $secret) {
      if (!preg_match('/^t=(\d+),v1=([0-9a-f]{64})$/', $header ?? '', $m)) return false;
      if (abs(time() - (int)$m[1]) > 300) return false;
      return hash_equals(hash_hmac('sha256', $m[1] . '.' . $raw, $secret), $m[2]);
    }

Notices can arrive more than once; handle them idempotently (use the order `id`). If your server was down, you can
always fall back to `GET /api/orders/<id>`.

## Coin ids
`ADA`, `USDCx`, `USDM`, `USDA`, `DJED`, `iUSD`, `BTC`, `LTC`, `BCH`, `GRS`, `ETH`, `USDTeth`, `USDCeth`, `BNB`, `USDTbsc`,
`USDCbsc`, `POL`, `USDTpol`, `USDCpol`, `TRX`, `USDTtrx`, `XMR`, plus any Cardano tokens you add in the dashboard.
