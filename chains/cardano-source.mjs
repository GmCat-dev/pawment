// Which Cardano data service to ask. Koios (free, no key) first; when it is busy (rate limit, 5xx, timeout) and a
// Blockfrost project key is set, Blockfrost answers instead, and Koios is left alone for a while so it can recover.
// Shared by the payment watcher and the wallet Pay button, so both back off together.
const KOIOS = { mainnet: 'https://api.koios.rest/api/v1', testnet: 'https://preprod.koios.rest/api/v1' };
const BLOCKFROST = { mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0', testnet: 'https://cardano-preprod.blockfrost.io/api/v0' };
const PAUSE_429 = 15 * 60, PAUSE_ERR = 3 * 60;   // seconds Koios is left alone after a refusal / an error

export const busy = (e) => /answered (429|5\d\d)|timeout|aborted|fetch failed|ECONN|ETIMEDOUT|network/i.test(String(e?.message || e));

export function createCardanoSource({ network = 'mainnet', fetchJson, blockfrostKey = '', koios = KOIOS[network], log = console.log, clock = () => Date.now() / 1000 }) {
  const bfKey = () => (typeof blockfrostKey === 'function' ? blockfrostKey() : blockfrostKey) || '';
  let pausedUntil = 0, last = 'koios', switches = 0;
  const koiosPaused = () => clock() < pausedUntil;
  const k = (path, body, query = '') => fetchJson(koios + path + query, body);
  const bf = (path) => fetchJson(BLOCKFROST[network] + path, undefined, { project_id: bfKey() });

  /** Ask Koios, or Blockfrost when Koios is busy. */
  async function pick(viaKoios, viaBlockfrost) {
    if (!(koiosPaused() && bfKey())) {
      try { const r = await viaKoios(); last = 'koios'; return r; } catch (e) {
        if (!bfKey() || !busy(e)) throw e;
        const pause = /answered 429/.test(e.message) ? PAUSE_429 : PAUSE_ERR;
        if (!koiosPaused()) { switches++; log(`cardano: Koios busy (${e.message}); using Blockfrost for ${pause / 60} min`); }
        pausedUntil = clock() + pause;
      }
    }
    const r = await viaBlockfrost(); last = 'blockfrost'; return r;
  }
  return {
    koios: k, blockfrost: bf, pick, bfKey, koiosPaused,
    blockfrostUrl: BLOCKFROST[network], koiosUrl: koios,
    status: () => ({ using: last, koios_paused: koiosPaused(), blockfrost: Boolean(bfKey()), switches }),
  };
}
