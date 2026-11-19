// Bitcoin-family plug-in (BTC, LTC, BCH, …): fresh watch-only addresses from an extended public key, payments read
// through public Electrum servers, every payment double-checked on a second server before it counts.
import { createHash } from 'node:crypto';
import { parseExtended, ckdPub } from './btc-keys.mjs';
import { profileFor, makeAddress, readAddress, scriptToAddress } from './utxo-coins.mjs';
import { createElectrumPool, txOutputs } from './electrum.mjs';
import { sha256 } from '../core/util.mjs';

const scripthash = (script) => Buffer.from(createHash('sha256').update(script).digest()).reverse().toString('hex');

export function createUtxoChain(coinId, { network = 'mainnet', pool: injected = null, log = console.log } = {}) {
  const p = profileFor(coinId, network);
  const pool = injected || createElectrumPool(p.servers, { log });
  const scripts = new Map();   // address -> script (Buffer)
  const remember = (a) => { scripts.set(a.address, a.script); return a.address; };
  function scriptOf(address) {
    if (!scripts.has(address)) { const a = readAddress(p, address); scripts.set(address, a.script); scripts.set(a.address, a.script); }
    return scripts.get(address);
  }

  return {
    id: coinId.toLowerCase(),
    name: p.name,
    network: p.network,
    nativeUnit: 'sat',
    second_source: true,
    wallet(spec) {
      if (spec.account_key) {
        const k = parseExtended(spec.account_key, p.versions, { check: p.check });
        const recv = ckdPub(k, 0);
        const cache = new Map();
        return {
          kind: 'account', fingerprint: 'xpub:' + sha256(k.key.toString('hex') + k.chain.toString('hex')).slice(0, 16),
          address: (i) => { if (!cache.has(i)) cache.set(i, remember(makeAddress(p, k.type, ckdPub(recv, i).key))); return cache.get(i); },
          label: `extended public key (${k.type === 'p2wpkh' ? 'native SegWit' : k.type === 'p2sh-p2wpkh' ? 'SegWit' : 'legacy'} addresses, fresh address per order)`,
        };
      }
      const a = readAddress(p, spec.address);
      remember(a);
      return { kind: 'single', fingerprint: 'addr:' + sha256(a.address).slice(0, 16), address: () => a.address, label: 'one address (orders told apart by exact amount)' };
    },
    checkAddress: (a) => remember(readAddress(p, a)),
    async tip() { return Number((await pool.request('blockchain.headers.subscribe', [])).height); },
    /** unspent outputs on these addresses (unconfirmed ones have block_height null) */
    async incoming(addresses) {
      const rows = [];
      const lists = await Promise.all(addresses.map(async (address) => {
        const r = await pool.request('blockchain.scripthash.listunspent', [scripthash(scriptOf(address))]);
        return r.map((u) => ({ address, u }));
      }));
      for (const { address, u } of lists.flat()) {
        rows.push({ ref: `${u.tx_hash}:${u.tx_pos}`, tx: u.tx_hash, address, block_height: u.height > 0 ? u.height : null, amounts: { sat: BigInt(u.value) } });
      }
      return rows;
    },
    /** outputs of one transaction (for "I already paid"); null if no server knows it */
    async transaction(tx) {
      if (!/^[0-9a-f]{64}$/.test(tx)) return null;
      let raw;
      try { raw = await pool.request('blockchain.transaction.get', [tx, false]); } catch { return null; }
      const outs = txOutputs(raw).map((o) => ({ ref: `${tx}:${o.index}`, tx, address: scriptToAddress(p, o.script), script: o.script, block_height: null, amounts: { sat: o.value } }));
      // its block height, from the history of the first output that pays one of our watched addresses
      const ours = outs.find((o) => o.address && scripts.has(o.address));
      if (ours) {
        try {
          const hist = await pool.request('blockchain.scripthash.get_history', [scripthash(ours.script)]);
          const h = hist.find((x) => x.tx_hash === tx);
          if (h && h.height > 0) outs.forEach((o) => { o.block_height = h.height; });
        } catch { /* height stays unknown: counted once the address watch sees it in a block */ }
      }
      return outs;
    },
    /** second opinion from a different Electrum server: the output must exist with the same script and amount */
    async confirm(ref, address, unit, amount) {
      const [tx, idx] = ref.split(':');
      const first = await pool.on('blockchain.transaction.get', [tx, false]).catch(() => null);
      const second = await pool.other('blockchain.transaction.get', [tx, false], first?.server);
      if (!second) return null;
      try {
        const o = txOutputs(second.result)[Number(idx)];
        return Boolean(o) && o.value === BigInt(amount) && o.script.equals(scriptOf(address));
      } catch { return false; }
    },
    depthNeeded: p.depth,
    minutesPerBlock: p.minutesPerBlock,
    explorer: (tx) => p.explorer + tx + (p.id === 'GRS' ? '.htm' : ''),
    paymentUri(address, coin, units) {
      const amt = (Number(units) / 10 ** p.decimals).toFixed(p.decimals).replace(/\.?0+$/, '');
      const base = p.cash ? address : `${p.scheme}:${address}`;
      return `${base}?amount=${amt}`;
    },
    async poolPrice() { throw new Error('not a token'); },
    close: () => pool.close(),
    _profile: p,
  };
}
