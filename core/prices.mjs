// Coin prices in US dollars. Two sources must agree before a price is used; a stale or missing price means
// the coin can't be picked for new orders (orders already priced keep their held amount).
//   {fixed: 1}                              stablecoins
//   {feeds: ["coingecko:cardano", "kraken:ADAUSD"]}   public price feeds (all that answer must agree within 5%)
//   {pool: "minswap"}                       a token's price in the chain's main coin, read from on-chain pools by the chain plug-in
//                                           (the plug-in checks two pools agree), times the main coin's dollar price

const FEED_URL = {
  coingecko: (id) => `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
  kraken: (pair) => `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
};
const FEED_READ = {
  coingecko: (data, id) => Number(data[id]?.usd),
  kraken: (data) => Number(Object.values(data.result || {})[0]?.c?.[0]),
};
export const MAX_AGE = 1800;
const AGREE = 1.05;

export function createPrices({ settings, chains, fetchJson, log = console.log, now }) {
  const cache = new Map();   // coin id -> {usd, at, sources}
  const errors = new Map();

  let batch = null;   // one CoinGecko question per refresh for every coin (its free limit is per server, shared with other apps)
  async function feedPrice(feeds) {
    const got = {};
    for (const f of feeds) {
      const [name, arg] = String(f).split(':');
      if (!FEED_URL[name]) continue;
      try {
        const data = name === 'coingecko' && batch ? await batch : await fetchJson(FEED_URL[name](arg));
        const v = FEED_READ[name](data, arg);
        if (v > 0) got[name] = v;
      } catch (e) { log(`price: ${name} failed: ${e.message}`); }
    }
    const vals = Object.values(got);
    if (!vals.length) throw new Error('no price feed answered');
    if (Math.max(...vals) / Math.min(...vals) > AGREE) throw new Error('price feeds disagree: ' + JSON.stringify(got));
    return { usd: vals.reduce((a, b) => a + b, 0) / vals.length, sources: got };
  }

  /**
   * A Cardano token someone added: DexScreener (liquidity-weighted, pools with at least $1,000), CoinGecko by token id,
   * and the on-chain Minswap pools. Whatever answers; two or more must agree within 10%.
   */
  async function tokenPrice(c, s) {
    const got = {};
    try {
      const d = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + c.unit);
      let liq = 0, sum = 0;
      for (const p of d.pairs || []) {
        if (p.chainId !== 'cardano' || String(p.baseToken?.address).toLowerCase() !== c.unit) continue;
        const l = Number(p.liquidity?.usd) || 0, pr = Number(p.priceUsd);
        if (l >= 1000 && pr > 0) { liq += l; sum += pr * l; }
      }
      if (liq) got.dexscreener = sum / liq;
    } catch (e) { log('price: dexscreener ' + c.id + ': ' + e.message); }
    for (const id of [c.unit, c.unit.slice(0, 56)]) {   // CoinGecko lists some Cardano tokens by policy id only
      try {
        const g = await fetchJson('https://api.coingecko.com/api/v3/coins/cardano/contract/' + id);
        const v = Number(g?.market_data?.current_price?.usd); if (v > 0) { got.coingecko = v; break; }
      } catch { /* not listed there */ }
    }
    try {
      const main = s.coins.find((m) => m.chain === c.chain && m.kind === 'native'), mp = main && get(main.id);
      if (mp && chains[c.chain]?.poolPrice) { const pp = await chains[c.chain].poolPrice(c); got.minswap_pools = pp.price * mp.usd; }
    } catch { /* busy tokens time out on the free pool lookup */ }
    const vals = Object.values(got);
    if (!vals.length) throw new Error('no price source knows this token yet');
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (Math.max(...vals) / Math.min(...vals) <= 1.10) return { usd: avg(vals), sources: got };
    // CoinGecko's price for small tokens can lag: the live markets (DexScreener, on-chain pools) win if they agree with each other
    const live = ['dexscreener', 'minswap_pools'].filter((k) => got[k]).map((k) => got[k]);
    if (live.length && Math.max(...live) / Math.min(...live) <= 1.10 && got.coingecko) {
      const usd = avg(live);
      return { usd, sources: got, warning: `CoinGecko's price is ${Math.round(Math.abs(got.coingecko / usd - 1) * 100)}% different (it can lag for small tokens); using the live market price` };
    }
    throw new Error('price sources disagree: ' + JSON.stringify(got));
  }

  async function refresh() {
    const s = settings();
    const ids = [...new Set(s.coins.flatMap((c) => (c.price.feeds || []).filter((f) => f.startsWith('coingecko:')).map((f) => f.slice(10))))];
    batch = ids.length ? fetchJson(FEED_URL.coingecko(ids.join(','))) : null;
    if (batch) batch.catch(() => {});
    // main coins (feeds / fixed) first, then pool-priced tokens, which need their chain's main coin price
    const ordered = [...s.coins].sort((a, b) => (a.price.pool ? 1 : 0) - (b.price.pool ? 1 : 0));
    for (const c of ordered) {
      if (!c.enabled && !Object.values(s.sites || {}).some((x) => x.coins?.[c.id]?.enabled)) continue;
      try {
        let r;
        if (c.price.fixed) r = { usd: Number(c.price.fixed), sources: { fixed: Number(c.price.fixed) } };
        else if (c.price.feeds) r = await feedPrice(c.price.feeds);
        else if (c.price.token) r = await tokenPrice(c, s);
        else {
          const chain = chains[c.chain];
          const main = s.coins.find((m) => m.chain === c.chain && m.kind === 'native');
          const mainPrice = main && get(main.id);
          if (!mainPrice) throw new Error(`no ${main?.id || 'main coin'} price yet`);
          const perMain = await chain.poolPrice(c);   // main coin per ONE whole token
          r = { usd: perMain.price * mainPrice.usd, sources: { ...perMain.sources, [main.id + '_usd']: mainPrice.usd } };
        }
        // a dollar coin far from $1 has lost its peg: don't take it until it's back (fixed prices are exactly 1 anyway)
        if (c.kind === 'stable' && Math.abs(r.usd - 1) > 0.05) throw new Error(c.id + ' is at $' + r.usd.toFixed(3) + ', more than 5% away from $1: paused');
        cache.set(c.id, { ...r, at: now() });
        errors.delete(c.id);
      } catch (e) {
        errors.set(c.id, e.message);
        log(`price: ${c.id}: ${e.message}`);
      }
    }
  }

  /** Current price, or null if missing or older than 30 minutes. */
  function get(id) {
    const p = cache.get(id);
    return p && now() - p.at <= MAX_AGE ? p : null;
  }
  const status = () => Object.fromEntries(settings().coins.map((c) => [c.id, { ...(cache.get(c.id) || {}), error: errors.get(c.id) || null, fresh: Boolean(get(c.id)) }]));
  /** for tests and restarts */
  const set = (id, usd) => cache.set(id, { usd, at: now(), sources: { manual: usd } });
  return { refresh, get, status, set, tokenPrice: (c) => tokenPrice(c, settings()) };
}
