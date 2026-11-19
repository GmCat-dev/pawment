// Pawment server. One small process: no blockchain node, no keys that can spend.
//
//   Sites:  POST /api/orders                 (Authorization: Bearer <site API key>)  -> {id, checkout_url, …}
//           GET  /api/orders/<id>            (same key)                              -> order status
//   Buyers: GET  /o/<id>                     checkout + receipt page (the id is the private link)
//           GET  /api/pay/<id>   POST /api/pay/<id>/quote {coin}   /claim {tx}   /refund {address, note}
//   Owner:  /admin/api/…                     (Authorization: Bearer <admin key>)    used by the admin page (and any owner tool)
//
// Settings: PAY_SETTINGS (default ./settings.json). Secrets: PAY_DATA/secrets.json (made by `node cli.mjs init`).
import { createServer } from 'node:http';
import { createApp } from './app.mjs';

const HOST = process.env.PAY_HOST || '127.0.0.1';
const PORT = Number(process.env.PAY_PORT || 4197);
const SWEEP_EVERY = Number(process.env.PAY_SWEEP_EVERY || 20) * 1000;

const app = await createApp();
const server = createServer((req, res) => { app.handle(req, res); });
const { engine, prices } = app;

if (process.env.PAY_NO_LISTEN !== '1') {
  server.listen(PORT, HOST, () => console.log(`${app.settings().name} listening on http://${HOST}:${PORT} (${app.settings().network})`));
  const loop = async () => { await app.tick(); setTimeout(loop, SWEEP_EVERY); };
  loop();
}
export { server, engine, prices };
