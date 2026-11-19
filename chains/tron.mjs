// TRON plug-in: TRX and TRC-20 tokens (USDT). Watch-only: one ordinary T… address; orders on it are told apart by
// exact amounts; the checkout's TronLink button sends the exact amount and hands back the transaction id.
// Incoming payments are read from TronGrid's indexed API; every payment is checked again on a different full node
// (publicnode / TronStack) before it counts.
import { b58check, b58uncheck } from './btc-keys.mjs';

const CFG = {
  mainnet: { name: 'TRON', explorer: 'https://tronscan.org/#/transaction/', grid: 'https://api.trongrid.io', nodes: ['https://tron-rpc.publicnode.com', 'https://api.tronstack.io', 'https://api.trongrid.io'] },   // TronGrid last: its free tier allows 3 requests a second
  testnet: { name: 'TRON Nile (test)', explorer: 'https://nile.tronscan.org/#/transaction/', grid: 'https://nile.trongrid.io', nodes: ['https://nile.trongrid.io'] },
};
const DEPTH = 20;                // TRON blocks are "solid" (final) after 19 confirmations, about a minute
const LOOKBACK_MS = 15 * 60_000; // when an address is first watched, look this far back

export const tronUnit = (contract) => 'trc20:' + contract;
const toHex = (b58) => b58uncheck(b58).toString('hex');           // 41 + 20 bytes
const toB58 = (hex) => b58check(Buffer.from(hex.replace(/^0x/, '').replace(/^(?!41)/, '41'), 'hex'));

/** a typed TRON address -> normalised T… form */
export function checkTronAddress(input) {
  const s = String(input || '').trim();
  let raw;
  try { raw = b58uncheck(s); } catch { throw new Error('That is not a valid TRON address (a character may be wrong or missing).'); }
  if (raw.length !== 21 || raw[0] !== 0x41) throw new Error('That is not a TRON address (it should start with T).');
  return b58check(raw);
}

export function createTronChain({ network = 'mainnet', tokens = () => [], fetchImpl = fetch, log = console.log } = {}) {
  const c = CFG[network] || CFG.mainnet;
  let gridNext = 0;
  async function get(url, body, retry = true) {
    if (url.startsWith(c.grid)) {   // pace TronGrid (free tier: 3 requests a second)
      const wait = gridNext - Date.now();
      gridNext = Math.max(Date.now(), gridNext) + 450;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const r = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Pawment/1' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { throw new Error(new URL(url).host + ' answered ' + r.status); }
    if (retry && /rate exceeded|suspended/i.test(String(j.Error || j.error?.message || j.message || ''))) { await new Promise((res) => setTimeout(res, 5500)); return get(url, body, false); }
    if (r.status >= 400 || j.Error || j.error) throw new Error(new URL(url).host + ': ' + String(j.Error || j.error?.message || j.message || r.status).slice(0, 120));
    return j;
  }
  /** ask full nodes in turn; returns {result, i} */
  async function node(path, body, { skip = -1 } = {}) {
    let last;
    for (let i = 0; i < c.nodes.length; i++) {
      if (i === skip) continue;
      try { return { result: await get(c.nodes[i] + path, body), i }; } catch (e) { last = e; }
    }
    throw last || new Error('no TRON node answered');
  }
  const tokenList = () => tokens().map((t) => t.contract);
  const state = new Map();   // address -> {since (ms)}
  const heights = new Map(); // txid -> block number (cache)
  async function heightOf(txid) {
    if (heights.has(txid)) return heights.get(txid);
    const info = (await node('/wallet/gettransactioninfobyid', { value: txid })).result;
    const h = info && info.blockNumber ? Number(info.blockNumber) : null;
    if (h) heights.set(txid, h);
    return h;
  }

  /** decode one transaction (full-node format) into rows paying `watch` (or anyone if null) */
  function rowsFromTx(tx, info, watch) {
    if (!tx?.raw_data?.contract?.length) return [];
    if (tx.ret?.[0]?.contractRet && tx.ret[0].contractRet !== 'SUCCESS') return [];
    if (info && info.receipt && info.receipt.result && info.receipt.result !== 'SUCCESS') return [];
    const ct = tx.raw_data.contract[0], v = ct.parameter?.value || {};
    const height = info?.blockNumber ? Number(info.blockNumber) : null;
    const rows = [];
    if (ct.type === 'TransferContract' && v.to_address && v.amount > 0) {
      const to = toB58(v.to_address);
      if (!watch || watch.has(to)) rows.push({ ref: `${tx.txID}:sun:${to}`, tx: tx.txID, address: to, block_height: height, amounts: { sun: BigInt(v.amount) } });
    }
    if (ct.type === 'TriggerSmartContract' && v.contract_address && /^a9059cbb/.test(v.data || '')) {
      const contract = toB58(v.contract_address);
      if (tokenList().includes(contract)) {
        const to = toB58('41' + v.data.slice(32, 72)), amount = BigInt('0x' + v.data.slice(72, 136));
        if (!watch || watch.has(to)) rows.push({ ref: `${tx.txID}:${tronUnit(contract)}:${to}`, tx: tx.txID, address: to, block_height: height, amounts: { [tronUnit(contract)]: amount } });
      }
    }
    return rows;
  }

  return {
    id: 'trx', name: c.name, network, nativeUnit: 'sun', second_source: c.nodes.length > 1,
    wallet(spec) {
      if (spec.account_key) throw new Error('TRON wallets use one ordinary T… address here.');
      const a = checkTronAddress(spec.address);
      return { kind: 'single', fingerprint: 'trx:' + a, address: () => a, label: 'one TRON address (orders told apart by exact amount)' };
    },
    checkAddress: (a) => checkTronAddress(a),
    async tip() { return Number((await node('/wallet/getnowblock', {})).result.block_header.raw_data.number); },
    async incoming(addresses) {
      const rows = [];
      for (const address of [...new Set(addresses.map(checkTronAddress))]) {
        let st = state.get(address);
        if (!st) { st = { since: Date.now() - LOOKBACK_MS }; state.set(address, st); }
        const since = st.since - 120_000;   // a little overlap; duplicates are ignored by the engine
        const started = Date.now();
        // TRX
        const trx = await get(`${c.grid}/v1/accounts/${address}/transactions?only_to=true&only_confirmed=false&limit=200&min_timestamp=${since}`);
        for (const tx of trx.data || []) rows.push(...rowsFromTx(tx, tx.blockNumber ? { blockNumber: tx.blockNumber } : null, new Set([address])));
        // tokens
        for (const contract of tokenList()) {
          const r = await get(`${c.grid}/v1/accounts/${address}/transactions/trc20?only_to=true&only_confirmed=false&limit=200&min_timestamp=${since}&contract_address=${contract}`);
          for (const t of r.data || []) {
            if (t.to !== address || t.type !== 'Transfer') continue;
            const unit = tronUnit(contract);
            rows.push({ ref: `${t.transaction_id}:${unit}:${address}`, tx: t.transaction_id, address, block_height: await heightOf(t.transaction_id).catch(() => null), amounts: { [unit]: BigInt(t.value) } });
          }
        }
        st.since = started;
      }
      return rows;
    },
    async transaction(txid) {
      const id = String(txid).replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/.test(id)) return null;
      const tx = (await node('/wallet/gettransactionbyid', { value: id }).catch(() => ({ result: null }))).result;
      if (!tx || !tx.txID) return null;
      const info = (await node('/wallet/gettransactioninfobyid', { value: id }).catch(() => ({ result: null }))).result;
      return rowsFromTx(tx, info && info.id ? info : null, null);
    },
    /** second opinion from a different full node: succeeded and paid exactly this to this address */
    async confirm(ref, address, unit, amount) {
      const txid = ref.split(':')[0];
      let first;
      try { first = await node('/wallet/gettransactionbyid', { value: txid }); } catch { return null; }
      try {
        const tx = (await node('/wallet/gettransactionbyid', { value: txid }, { skip: first.i })).result;
        const info = (await node('/wallet/gettransactioninfobyid', { value: txid }, { skip: first.i })).result;
        if (!tx?.txID || !info?.blockNumber) return false;
        const r = rowsFromTx(tx, info, new Set([address])).find((x) => x.amounts[unit] !== undefined);
        return Boolean(r) && r.amounts[unit] === BigInt(amount);
      } catch { return null; }
    },
    exportState: () => Object.fromEntries([...state].map(([a, st]) => [a, { since: st.since }])),
    importState(saved) { for (const [a, st] of Object.entries(saved || {})) state.set(a, { since: Math.max(Number(st.since), Date.now() - 86400000) }); },   // up to a day back
    depthNeeded: () => DEPTH,
    minutesPerBlock: 0.05,
    explorer: (tx) => c.explorer + tx,
    paymentUri: (address) => address,   // TRON has no widely supported payment link: the QR holds the address
    payInfo(unit) { return { type: 'tron', contract: unit && unit !== 'sun' ? unit.slice(6) : null }; },
    async poolPrice() { throw new Error('not a pool token'); },
    _toHex: toHex,
  };
}
