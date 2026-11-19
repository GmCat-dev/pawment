// Ethereum-family plug-in (Ethereum, BNB Smart Chain, Polygon): the coin itself (ETH / BNB / POL) and ERC-20 tokens
// (USDT, USDC). Watch-only: the owner gives one ordinary 0x address; orders on it are told apart by exact amounts,
// and the checkout's wallet button (MetaMask-style) sends the exact amount and hands back the transaction id.
// Reads public JSON-RPC servers (no keys); every payment is checked again on a second server before it counts.
//   tokens: Transfer events to our address (eth_getLogs), every sweep
//   coin:   the address balance is checked every sweep; only when it changes are the new blocks scanned for transfers
import { toChecksum, checkEvmAddress } from '../core/keccak.mjs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const EVM = {
  eth: { name: 'Ethereum', chainId: 1, symbol: 'ETH', explorer: 'https://etherscan.io/tx/', blockSeconds: 12,
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'], depth: (u) => (u <= 500 ? 3 : u <= 5000 ? 12 : 32),
    add: { chainName: 'Ethereum', rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'] },
    testnet: { name: 'Ethereum Sepolia', chainId: 11155111, explorer: 'https://sepolia.etherscan.io/tx/', rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'], add: { chainName: 'Sepolia', rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] } } },
  bsc: { name: 'BNB Smart Chain', chainId: 56, symbol: 'BNB', explorer: 'https://bscscan.com/tx/', blockSeconds: 0.5,
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'], depth: (u) => (u <= 500 ? 15 : u <= 5000 ? 30 : 60),
    add: { chainName: 'BNB Smart Chain', rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
    testnet: { name: 'BNB Smart Chain testnet', chainId: 97, explorer: 'https://testnet.bscscan.com/tx/', rpcs: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.drpc.org'], add: { chainName: 'BNB Smart Chain Testnet', rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], blockExplorerUrls: ['https://testnet.bscscan.com'] } } },
  polygon: { name: 'Polygon', chainId: 137, symbol: 'POL', explorer: 'https://polygonscan.com/tx/', blockSeconds: 2,
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'], depth: (u) => (u <= 500 ? 20 : u <= 5000 ? 40 : 64),
    add: { chainName: 'Polygon', rpcUrls: ['https://polygon-bor-rpc.publicnode.com'], blockExplorerUrls: ['https://polygonscan.com'] },
    testnet: { name: 'Polygon Amoy', chainId: 80002, explorer: 'https://amoy.polygonscan.com/tx/', rpcs: ['https://polygon-amoy-bor-rpc.publicnode.com', 'https://polygon-amoy.drpc.org'], add: { chainName: 'Polygon Amoy', rpcUrls: ['https://polygon-amoy-bor-rpc.publicnode.com'], blockExplorerUrls: ['https://amoy.polygonscan.com'] } } },
};
const LOG_RANGE = 800;          // blocks per eth_getLogs question
const SCAN_PER_SWEEP = 240;     // most blocks scanned for coin transfers in one sweep (the rest next time)
const LOOKBACK_SECONDS = 600;   // when an address is first watched (or after a restart), look this far back for token transfers
const COIN_LOOKBACK_SECONDS = 60;   // … and this far back for coin transfers (whole blocks are read, so kept short)

const hex = (n) => '0x' + BigInt(n).toString(16);
const pad32 = (h) => h.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const tokenUnit = (contract) => 'erc20:' + contract.toLowerCase();

export function createEvmChain(id, { network = 'mainnet', tokens = () => [], fetchImpl = fetch, log = console.log } = {}) {
  const base = EVM[id];
  if (!base) throw new Error('unknown chain ' + id);
  const p = network === 'testnet' ? { ...base, ...base.testnet } : base;
  const healthy = p.rpcs.map(() => 0);   // time of last failure per server

  async function rpcOn(i, method, params) {
    const r = await fetchImpl(p.rpcs[i], { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Pawment/1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(new URL(p.rpcs[i]).host + ' answered ' + r.status); }
    if (j.error) throw new Error(new URL(p.rpcs[i]).host + ': ' + String(j.error.message || '').slice(0, 120));
    return j.result;
  }
  /** first server that answers (servers that failed recently go last); returns {result, i} */
  async function rpc(method, params, { skip = -1 } = {}) {
    const order = p.rpcs.map((_, i) => i).filter((i) => i !== skip).sort((a, b) => (healthy[a] > Date.now() - 300000) - (healthy[b] > Date.now() - 300000));
    let last;
    for (const i of order) {
      try { return { result: await rpcOn(i, method, params), i }; } catch (e) { last = e; healthy[i] = Date.now(); }
    }
    throw last || new Error('no server answered');
  }
  const call = async (m, params) => (await rpc(m, params)).result;
  const tokenList = () => tokens().map((t) => t.contract.toLowerCase());
  const state = new Map();   // address -> {logFrom, coinFrom, balance}

  function rowsFromReceipt(txHash, receipt, watch) {
    const sums = new Map();
    for (const lg of receipt.logs || []) {
      if (lg.topics?.[0] !== TRANSFER || lg.topics.length !== 3) continue;
      const contract = lg.address.toLowerCase();
      if (!tokenList().includes(contract)) continue;
      const to = toChecksum('0x' + lg.topics[2].slice(26));
      if (watch && !watch.has(to.toLowerCase())) continue;
      const key = contract + '|' + to;
      sums.set(key, (sums.get(key) || 0n) + BigInt(lg.data));
    }
    const height = receipt.blockNumber ? Number(receipt.blockNumber) : null;
    return [...sums].map(([key, amount]) => {
      const [contract, to] = key.split('|');
      const unit = tokenUnit(contract);
      return { ref: `${txHash}:${unit}:${to.toLowerCase()}`, tx: txHash, address: to, block_height: height, amounts: { [unit]: amount } };
    });
  }
  const coinRow = (tx) => ({ ref: `${tx.hash}:wei:${tx.to.toLowerCase()}`, tx: tx.hash, address: toChecksum(tx.to), block_height: tx.blockNumber ? Number(tx.blockNumber) : null, amounts: { wei: BigInt(tx.value) } });

  return {
    id, name: p.name, network, nativeUnit: 'wei', second_source: p.rpcs.length > 1, chainId: p.chainId,
    wallet(spec) {
      if (spec.account_key) throw new Error('Ethereum-style wallets use one ordinary 0x address here (the same one works on Ethereum, BNB Smart Chain and Polygon).');
      const a = checkEvmAddress(spec.address);
      return { kind: 'single', fingerprint: 'evm:' + a.toLowerCase(), address: () => a, label: 'one 0x address (orders told apart by exact amount)' };
    },
    checkAddress: (a) => checkEvmAddress(a),
    async tip() { return Number(await call('eth_blockNumber', [])); },
    async incoming(addresses) {
      const tip = Number(await call('eth_blockNumber', []));
      const rows = [];
      for (const address of [...new Set(addresses.map((a) => toChecksum(a)))]) {
        let st = state.get(address);
        const back = Math.ceil(LOOKBACK_SECONDS / p.blockSeconds);
        if (st?.catchUp) {   // first sweep after a restart: if the balance moved meanwhile, re-read the missed blocks (up to ~30 min)
          st.catchUp = false;
          const cap = Math.ceil(1800 / p.blockSeconds);
          if (st.coinFrom > tip) st.coinFrom = tip + 1;
          st.resumeFrom = Math.max(st.coinFrom, tip - cap);
          st.logFrom = Math.max(st.logFrom, tip - Math.ceil(86400 / p.blockSeconds));   // tokens: up to a day back
        }
        if (!st) { st = { logFrom: Math.max(0, tip - back), coinFrom: Math.max(0, tip - Math.ceil(COIN_LOOKBACK_SECONDS / p.blockSeconds)), balance: null }; state.set(address, st); }
        // tokens
        const list = tokenList();
        if (list.length) {
          while (st.logFrom <= tip) {
            const to = Math.min(tip, st.logFrom + LOG_RANGE - 1);
            const logs = await call('eth_getLogs', [{ fromBlock: hex(st.logFrom), toBlock: hex(to), address: list, topics: [TRANSFER, null, '0x' + pad32(address)] }]);
            const byTx = new Map();
            for (const lg of logs) { if (!byTx.has(lg.transactionHash)) byTx.set(lg.transactionHash, []); byTx.get(lg.transactionHash).push(lg); }
            for (const [txh, lgs] of byTx) rows.push(...rowsFromReceipt(txh, { logs: lgs, blockNumber: lgs[0].blockNumber }, new Set([address.toLowerCase()])));
            st.logFrom = to + 1;
          }
        }
        // the coin itself: only when the balance moved
        const bal = BigInt(await call('eth_getBalance', [address, 'latest']));
        if (st.balance !== null && bal !== st.balance && st.coinFrom > tip) st.coinFrom = st.resumeFrom !== undefined ? st.resumeFrom : Math.max(0, tip - Math.ceil(60 / p.blockSeconds));   // re-scan the missed blocks
        delete st.resumeFrom;
        if (st.balance === null) st.balance = bal;
        if (st.coinFrom <= tip) {
          const end = Math.min(tip, st.coinFrom + SCAN_PER_SWEEP - 1);
          for (let n = st.coinFrom; n <= end; n++) {
            const b = await call('eth_getBlockByNumber', [hex(n), true]);
            for (const tx of b?.transactions || []) if (tx.to && tx.to.toLowerCase() === address.toLowerCase() && BigInt(tx.value) > 0n) rows.push(coinRow(tx));
          }
          st.coinFrom = end + 1;
          if (st.coinFrom > tip) st.balance = bal;
        }
      }
      return rows;
    },
    /** one transaction (for "I already paid" and the wallet button); pending ones come back without a block height */
    async transaction(txHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
      const tx = await call('eth_getTransactionByHash', [txHash]).catch(() => null);
      if (!tx) return null;
      const receipt = await call('eth_getTransactionReceipt', [txHash]).catch(() => null);
      if (receipt && receipt.status === '0x0') return [];   // failed: nothing was paid
      const rows = [];
      if (tx.to && BigInt(tx.value) > 0n) rows.push(coinRow(tx));
      if (receipt) rows.push(...rowsFromReceipt(tx.hash, receipt, null));
      else if (tx.to && tokenList().includes(tx.to.toLowerCase()) && /^0xa9059cbb/i.test(tx.input) && tx.input.length >= 138) {
        // still waiting: read the token transfer from the call itself
        const to = toChecksum('0x' + tx.input.slice(34, 74)), amount = BigInt('0x' + tx.input.slice(74, 138)), unit = tokenUnit(tx.to);
        rows.push({ ref: `${tx.hash}:${unit}:${to.toLowerCase()}`, tx: tx.hash, address: to, block_height: null, amounts: { [unit]: amount } });
      }
      return rows;
    },
    /** second opinion from a different server: mined, succeeded, and paid exactly this to this address */
    async confirm(ref, address, unit, amount) {
      const txHash = ref.split(':')[0];
      let first;
      try { first = await rpc('eth_getTransactionReceipt', [txHash]); } catch { return null; }
      let receipt, tx;
      try {
        receipt = (await rpc('eth_getTransactionReceipt', [txHash], { skip: first.i })).result;
        if (unit === 'wei') tx = (await rpc('eth_getTransactionByHash', [txHash], { skip: first.i })).result;
      } catch { return null; }
      if (!receipt || receipt.status !== '0x1') return false;
      if (unit === 'wei') return Boolean(tx) && tx.to?.toLowerCase() === address.toLowerCase() && BigInt(tx.value) === BigInt(amount);
      const got = rowsFromReceipt(txHash, receipt, new Set([address.toLowerCase()])).filter((r) => r.amounts[unit] !== undefined);
      return got.length === 1 && got[0].amounts[unit] === BigInt(amount);
    },
    exportState: () => Object.fromEntries([...state].map(([a, st]) => [a, { logFrom: st.logFrom, coinFrom: st.coinFrom, balance: st.balance === null ? null : String(st.balance) }])),
    /** after a restart: carry on from where reading stopped (coin-transfer catch-up capped at about 30 minutes of blocks) */
    importState(saved) {
      for (const [a, st] of Object.entries(saved || {})) state.set(a, { logFrom: Number(st.logFrom), coinFrom: Number(st.coinFrom), balance: st.balance === null ? null : BigInt(st.balance), catchUp: true });
    },
    depthNeeded: p.depth,
    minutesPerBlock: p.blockSeconds / 60,
    explorer: (tx) => p.explorer + tx,
    /** EIP-681 payment link (MetaMask mobile, Trust Wallet and others read these) */
    paymentUri(address, coin, units) {
      if (!coin.unit || coin.unit === 'wei') return `ethereum:${address}@${p.chainId}?value=${BigInt(units)}`;
      return `ethereum:${coin.unit.slice(6)}@${p.chainId}/transfer?address=${address}&uint256=${BigInt(units)}`;
    },
    /** what the checkout's wallet button needs */
    payInfo(unit) {
      return { type: 'evm', chain_id: p.chainId, chain_name: p.name, native: p.symbol, contract: unit && unit !== 'wei' ? toChecksum(unit.slice(6)) : null, add: { chainId: '0x' + p.chainId.toString(16), nativeCurrency: { name: p.symbol, symbol: p.symbol, decimals: 18 }, ...p.add } };
    },
    async poolPrice() { throw new Error('not a pool token'); },
  };
}
