# Security

> **Beta software, still under development.**

## Reporting a problem
Found a security problem in Pawment? Please **don't open a public issue**. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on this repository) or the form at https://support.gmcat.io/ . We'll answer as soon
as we can, and credit you if you'd like.

Especially welcome: anything that could make Pawment mark an order paid that wasn't, send a buyer to the wrong address,
let someone change a receiving wallet, or read another site's orders.

## How Pawment is kept safe
- **Watch-only.** It never holds a seed, private key or spend key, so a break-in can't move your coins. The worst a
  break-in can do is change where new orders send money, so wallet changes need the dashboard password, are logged, and
  email the owner at once.
- **Two sources.** Every payment is read from one public blockchain service and checked with a second one whenever it
  answers. If the two disagree, the payment is held in the **Needs you** list instead of counting.
- **Secrets are hashed or kept in files** readable only by the service user (dashboard password: scrypt; API and admin
  keys: SHA-256). Nothing secret is printed or returned by the API after it is created.
- **Signed notices** to your site (HMAC-SHA256 with a timestamp), so your shop can tell real ones from fakes.
- **Strict pages:** a Content-Security-Policy that only allows Pawment's own scripts, no frames, rate limits on sign-in,
  checkout and API calls, and same-origin checks on every dashboard change.
- **No outside code at run time:** no CDNs, trackers or analytics in the checkout or dashboard.

## Good to know
- Pawment trusts the `X-Real-IP` and `X-Forwarded-Proto` headers from the proxy in front of it (for rate limits and
  Secure cookies). Keep it listening on `127.0.0.1` (the default) behind Nginx, never directly on the internet.
- Notify URLs come from your own sites (API key holders), and Pawment posts to them from your server. Only give site
  API keys to shops you run or trust.

## Your part
- Use a wallet or account only for payments, and keep its seed offline.
- Use a long dashboard password, HTTPS, and keep the server and Node.js updated.
- Check payments in your own wallet too, especially large ones, while Pawment is in beta.
