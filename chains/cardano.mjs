// Cardano plug-in: ADA and any Cardano token (USDCx, USDM, …). Watch-only.
// Reads the chain through Koios (free, no key). If a Blockfrost project key is set, every payment is checked a second
// time there before it counts (if the two disagree, the payment goes to "Payments to check"), and Blockfrost takes over
// reading whenever Koios is busy (see cardano-source.mjs).
import { parseAccountKey, baseAddress, checkAddress } from './cardano-keys.mjs';
import { sha256 } from '../core/util.mjs';
import { createCardanoSource } from './cardano-source.mjs';

const KOIOS = { mainnet: 'https://api.koios.rest/api/v1', testnet: 'https://preprod.koios.rest/api/v1' };
const BLOCKFROST = { mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0', testnet: 'https://cardano-preprod.blockfrost.io/api/v0' };
const EXPLORER = { mainnet: 'https://cardanoscan.io/transaction/', testnet: 'https://preprod.cardanoscan.io/transaction/' };
const MINSWAP_POOLS = {   // Minswap V1 and V2 pool script addresses (each holds many pools), (public, well known)
  'addr1z8snz7c4974vzdpxu65ruphl3zjdvtxw8strf2c2tmqnxz2j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq0xmsha': 'Minswap V1',
  'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a': 'Minswap V2',
};
const MIN_POOL_ADA = 500;
const BATCH = 40;   // Koios refuses a question longer than 5120 bytes (about 47 addresses)

export function createCardano({ network = 'mainnet', fetchJson, blockfrostKey = '', koios = KOIOS[network], source = null, log }) {
  const src = source || createCardanoSource({ network, fetchJson, blockfrostKey, koios, log });
  const bfKey = src.bfKey;
  const net = network === 'mainnet' ? 1 : 0;
  const k = src.koios, bf = src.blockfrost;
  const notFound = (e) => /answered 404/.test(String(e?.message));
  /** every page of a Blockfrost list (100 a page); an address nobody ever used is a 404 = nothing there */
  async function bfAll(path, max = 20) {
    const out = [];
    for (let page = 1; page <= max; page++) {
      let rows;
      try { rows = await bf(path + (path.includes('?') ? '&' : '?') + 'count=100&page=' + page); } catch (e) { if (notFound(e)) return out; throw e; }
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }
  const heights = new Map();   // block hash -> height
  async function heightOf(hash) {
    if (!hash) return null;
    if (!heights.has(hash)) { if (heights.size > 5000) heights.clear(); heights.set(hash, Number((await bf('/blocks/' + hash)).height)); }
    return heights.get(hash);
  }
  /** a Blockfrost amount list [{unit, quantity}] into {lovelace: n, <unit>: n} */
  const bfAmounts = (list) => { const a = { lovelace: 0n }; for (const x of list || []) a[x.unit] = (a[x.unit] || 0n) + BigInt(x.quantity); return a; };

  /** Read Koios outputs (tx_info outputs or address_utxos rows) into {ref, tx, address, block_height, amounts}. */
  function outputRow(u, tx = u.tx_hash, height = u.block_height) {
    const amounts = { lovelace: BigInt(u.value) };
    for (const a of u.asset_list || []) {
      const unit = a.policy_id + (a.asset_name || '');
      amounts[unit] = (amounts[unit] || 0n) + BigInt(a.quantity);
    }
    return { ref: `${tx}#${u.tx_index}`, tx, address: u.address || u.payment_addr?.bech32, block_height: height ?? null, amounts };
  }

  return {
    id: 'cardano',
    nativeUnit: 'lovelace',
    name: 'Cardano',
    network,
    get second_source() { return Boolean(bfKey()); },
    sourceStatus: () => src.status(),
    /** Turn what the owner pasted into a wallet: an account public key (fresh addresses) or one address. */
    wallet(spec) {
      if (spec.account_key) {
        const key = parseAccountKey(spec.account_key);
        return {
          kind: 'account', fingerprint: 'acct:' + sha256(key.toString('hex')).slice(0, 16),
          address: (i) => baseAddress(key, i, { network: net }),
          label: 'account public key (fresh address per order)',
        };
      }
      const a = checkAddress(spec.address, { network: net });
      return { kind: 'single', fingerprint: 'addr:' + sha256(a).slice(0, 16), address: () => a, label: 'one address (orders told apart by exact amount)' };
    },
    checkAddress: (a) => checkAddress(a, { network: net }),
    async tip() {
      return src.pick(async () => Number((await k('/tip'))[0].block_no), async () => Number((await bf('/blocks/latest')).height));
    },
    /** Every unspent output now sitting on these addresses. */
    async incoming(addresses) {
      return src.pick(async () => {
        const out = [];
        for (let i = 0; i < addresses.length; i += BATCH) {
          const rows = await k('/address_utxos', { _addresses: addresses.slice(i, i + BATCH), _extended: true });
          for (const u of rows) out.push(outputRow(u));
        }
        return out;
      }, async () => {
        const out = [];
        for (const a of addresses) {
          for (const u of await bfAll('/addresses/' + a + '/utxos')) {
            out.push({ ref: `${u.tx_hash}#${u.output_index}`, tx: u.tx_hash, address: a, block_height: await heightOf(u.block), amounts: bfAmounts(u.amount) });
          }
        }
        return out;
      });
    },
    /** The outputs of one transaction (for "I already paid"). Returns null if the chain doesn't know it (yet). */
    async transaction(tx) {
      if (!/^[0-9a-f]{64}$/.test(tx)) return null;
      return src.pick(async () => {
        const rows = await k('/tx_info', { _tx_hashes: [tx], _inputs: false, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
        if (!rows.length) return null;
        return rows[0].outputs.map((o) => outputRow(o, tx, rows[0].block_height));
      }, async () => {
        let info, u;
        try { info = await bf('/txs/' + tx); u = await bf('/txs/' + tx + '/utxos'); } catch (e) { if (notFound(e)) return null; throw e; }
        return (u.outputs || []).map((o) => ({ ref: `${tx}#${o.output_index}`, tx, address: o.address, block_height: info.block_height ?? null, amounts: bfAmounts(o.amount) }));
      });
    },
    /** Second opinion (Blockfrost). true = agrees, false = disagrees, null = no second source set up or it didn't answer. */
    async confirm(ref, address, unit, amount) {
      if (!bfKey()) return null;
      const [tx, idx] = ref.split('#');
      if (src.koiosPaused()) {   // Blockfrost found it, so the other service is the one to ask
        try {
          const rows = await k('/tx_info', { _tx_hashes: [tx], _inputs: false, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
          const o = rows[0] && rows[0].outputs.map((x) => outputRow(x, tx)).find((x) => x.ref === ref);
          if (!o) return rows.length ? false : null;
          return o.address === address && (o.amounts[unit] || 0n) === BigInt(amount);
        } catch { return null; }
      }
      try {
        const u = await bf(`/txs/${tx}/utxos`);
        const o = (u.outputs || []).find((x) => String(x.output_index) === idx);
        if (!o || o.address !== address) return false;
        const q = (o.amount || []).find((x) => x.unit === unit);
        return Boolean(q) && BigInt(q.quantity) === BigInt(amount);
      } catch { return null; }
    },
    /** Blocks on top before a payment counts: more for bigger amounts (a Cardano block is about 20 seconds). */
    depthNeeded: (usd) => (usd <= 100 ? 3 : usd <= 1000 ? 6 : 15),
    minutesPerBlock: 1 / 3,
    explorer: (tx) => EXPLORER[network] + tx,
    /** What goes in the QR code. ADA: a CIP-13 payment link wallets understand; tokens: the address (amount shown beside it). */
    paymentUri(address, coin, units) {
      if (coin.unit !== 'lovelace') return address;
      const ada = (Number(units) / 1e6).toFixed(6).replace(/\.?0+$/, '');
      return `web+cardano:${address}?amount=${ada}`;
    },
    /** Price of one whole token in ADA, from Minswap pools (two pools must agree within 10% if both exist). */
    async poolPrice(coin) {
      if (network !== 'mainnet') return { price: Number(coin.price.testnet_ada || 1), sources: { testnet: true } };
      const policy = coin.unit.slice(0, 56), name = coin.unit.slice(56);
      const filter = `?address=in.(${Object.keys(MINSWAP_POOLS).join(',')})`;
      const rows = await src.pick(() => k('/asset_utxos', { _asset_list: [[policy, name]], _extended: true }, filter), async () => {
        const out = [];
        for (const addr of Object.keys(MINSWAP_POOLS)) {
          for (const u of await bfAll('/addresses/' + addr + '/utxos/' + coin.unit, 5)) {
            const am = bfAmounts(u.amount);
            out.push({ address: addr, value: String(am.lovelace), asset_list: [{ policy_id: policy, asset_name: name, quantity: String(am[coin.unit] || 0n) }] });
          }
        }
        return out;
      });
      const pools = {};
      for (const u of rows) {
        const label = MINSWAP_POOLS[u.address];
        if (!label) continue;
        const tokens = (u.asset_list || []).filter((a) => a.policy_id + (a.asset_name || '') === coin.unit).reduce((s, a) => s + Number(a.quantity), 0);
        const ada = Number(u.value) / 1e6;
        // only ADA/token pools: skip pools pairing the token with something else (they hold little ADA)
        if (tokens && ada >= MIN_POOL_ADA) {
          const p = (pools[label] ||= [0, 0]);
          p[0] += ada; p[1] += tokens / 10 ** coin.decimals;
        }
      }
      const per = Object.fromEntries(Object.entries(pools).map(([n, [a, t]]) => [n, a / t]));
      const vals = Object.values(per);
      if (!vals.length) throw new Error('no Minswap pool with enough ADA for ' + coin.id);
      if (vals.length > 1 && Math.max(...vals) / Math.min(...vals) > 1.1) throw new Error('pools disagree by more than 10%: ' + JSON.stringify(per));
      const totA = Object.values(pools).reduce((s, [a]) => s + a, 0), totT = Object.values(pools).reduce((s, [, t]) => s + t, 0);
      return { price: totA / totT, sources: per };
    },
  };
}
