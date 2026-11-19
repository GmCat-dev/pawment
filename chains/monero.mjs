// Monero plug-in: a fresh subaddress per order from the wallet's private VIEW key + primary address (watch-only:
// the view key sees incoming payments but can't spend). New blocks are read from public Monero nodes and every
// output is checked with the view key (view tags make most checks cheap). Only scans while orders are waiting.
// Every payment is checked again on a second node before it counts.
import { moneroWallet, decodeAddress } from './monero-keys.mjs';
import { sha256 } from '../core/util.mjs';

const CFG = {
  mainnet: { name: 'Monero', explorer: 'https://xmrchain.net/tx/', nodes: ['https://xmr-node.cakewallet.com:18081', 'https://monero.stackwallet.com:18081', 'https://xmr.cryptostorm.is:18081', 'https://node.monerodevs.org:18089'] },
  testnet: { name: 'Monero stagenet', explorer: 'https://stagenet.xmrchain.net/tx/', nodes: ['http://node.monerodevs.org:38089', 'http://stagenet.xmr-tw.org:38081', 'http://node2.monerodevs.org:38089'] },
};
const BLOCKS_PER_SWEEP = 12;   // about 24 minutes of blocks per sweep at most (catches up over a few sweeps)
const LOOKBACK = 3;            // when an order's address is first watched, look this many blocks back
const TX_BATCH = 20;

export function createMoneroChain({ network = 'mainnet', fetchImpl = fetch, log = console.log } = {}) {
  const c = CFG[network] || CFG.mainnet;
  const failed = c.nodes.map(() => 0);
  async function on(i, path, body) {
    const r = await fetchImpl(c.nodes[i] + path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Pawment/1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => { throw new Error(new URL(c.nodes[i]).host + ' answered ' + r.status); });
    if (j.error) throw new Error(new URL(c.nodes[i]).host + ': ' + (j.error.message || JSON.stringify(j.error)).slice(0, 120));
    if (j.status && j.status !== 'OK') throw new Error(new URL(c.nodes[i]).host + ': ' + j.status);
    return j;
  }
  async function node(path, body, { skip = -1 } = {}) {
    const order = c.nodes.map((_, i) => i).filter((i) => i !== skip).sort((a, b) => (failed[a] > Date.now() - 300000) - (failed[b] > Date.now() - 300000));
    let last;
    for (const i of order) { try { return { result: await on(i, path, body), i }; } catch (e) { last = e; failed[i] = Date.now(); } }
    throw last || new Error('no Monero node answered');
  }
  const rpc = async (method, params = {}) => (await node('/json_rpc', { jsonrpc: '2.0', id: '0', method, params })).result.result;
  /** decoded transactions: [{hash, json, height (null while waiting)}] */
  async function getTxs(hashes, opts) {
    const out = [];
    for (let k = 0; k < hashes.length; k += TX_BATCH) {
      const r = (await node('/get_transactions', { txs_hashes: hashes.slice(k, k + TX_BATCH), decode_as_json: true }, opts)).result;
      for (const t of r.txs || []) out.push({ hash: t.tx_hash, json: JSON.parse(t.as_json), height: t.in_pool ? null : t.block_height });
    }
    return out;
  }

  const wallets = new Map();   // fingerprint -> wallet
  const byAddress = new Map(); // subaddress -> wallet
  let cursor = null;           // next block height to scan
  const rowsFor = (t, w) => w.scan(t.json).map((f) => ({ ref: `${t.hash}:${f.index}`, tx: t.hash, address: f.address, block_height: t.height, amounts: { piconero: f.amount } }));

  return {
    id: 'xmr', name: c.name, network, nativeUnit: 'piconero', second_source: c.nodes.length > 1,
    wallet(spec) {
      if (!spec.view_key) throw new Error('Monero needs the wallet\'s primary address AND its private VIEW key (never the spend key or seed).');
      const fp = 'xmr:' + sha256(String(spec.address).trim()).slice(0, 16);
      const w = wallets.get(fp) || moneroWallet(spec.address, spec.view_key, network);   // one wallet object per wallet: it remembers its subaddresses
      wallets.set(fp, w);
      return {
        kind: 'account', fingerprint: fp,
        address: (i) => { const a = w.address(i); byAddress.set(a, w); return a; },
        label: 'view key (fresh subaddress per order)',
      };
    },
    checkAddress(a) {
      const d = decodeAddress(a);
      if (d.net !== network) throw new Error('That Monero address is for a different network.');
      return String(a).trim();
    },
    async tip() { return Number((await rpc('get_block_count')).count) - 1; },
    /** scan new blocks (only while some of our subaddresses are being watched) */
    async incoming(addresses) {
      for (const a of addresses) if (!byAddress.has(a)) for (const w of wallets.values()) if (w.adopt(a)) { byAddress.set(a, w); break; }
      const ours = addresses.filter((a) => byAddress.has(a));
      if (!ours.length) return [];
      const top = Number((await rpc('get_block_count')).count) - 1;
      if (cursor === null) cursor = top - LOOKBACK;
      if (cursor < top - 720) cursor = top - 720;   // after a long pause, look back at most a day
      const end = Math.min(top, cursor + BLOCKS_PER_SWEEP - 1);
      const rows = [];
      const ws = [...new Set(ours.map((a) => byAddress.get(a)))];
      for (let h = cursor; h <= end; h++) {
        const blk = await rpc('get_block', { height: h });
        const hashes = blk.tx_hashes || [];
        if (!hashes.length) continue;
        for (const t of await getTxs(hashes)) for (const w of ws) rows.push(...rowsFor(t, w));
      }
      cursor = end + 1;
      return rows.filter((r) => ours.includes(r.address));
    },
    /** one transaction (for "I already paid"); waiting ones come back without a block height */
    async transaction(txid) {
      if (!/^[0-9a-f]{64}$/.test(txid)) return null;
      const [t] = await getTxs([txid]).catch(() => []);
      if (!t) return null;
      return [...wallets.values()].flatMap((w) => rowsFor(t, w));
    },
    /** second opinion: a different node's copy of the transaction, decoded again, must pay exactly this */
    async confirm(ref, address, unit, amount) {
      const [txid, idx] = ref.split(':');
      let w = byAddress.get(address);
      if (!w) for (const x of wallets.values()) if (x.adopt(address)) { w = x; byAddress.set(address, x); break; }
      if (!w) return null;
      let first;
      try { first = await node('/get_transactions', { txs_hashes: [txid], decode_as_json: true }); } catch { return null; }
      try {
        const [t] = await getTxs([txid], { skip: first.i });
        if (!t || t.height === null) return false;
        const f = w.scan(t.json).find((x) => String(x.index) === idx);
        return Boolean(f) && f.address === address && f.amount === BigInt(amount);
      } catch { return null; }
    },
    exportState: () => ({ cursor }),
    importState(saved) { if (Number.isInteger(saved?.cursor)) cursor = saved.cursor; },   // carries on from the last block read (12 blocks per sweep)
    depthNeeded: (usd) => (usd <= 500 ? 2 : usd <= 5000 ? 6 : 10),
    minutesPerBlock: 2,
    explorer: (tx) => c.explorer + tx,
    paymentUri(address, coin, units) { return `monero:${address}?tx_amount=${(Number(units) / 1e12).toFixed(12).replace(/\.?0+$/, '')}`; },
    async poolPrice() { throw new Error('not a pool token'); },
  };
}
