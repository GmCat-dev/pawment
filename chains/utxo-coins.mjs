// Bitcoin-family coin profiles: which extended keys each coin accepts, how its addresses look, its payment links,
// explorers, confirmation needs and public Electrum servers (the same kind Bitcart and Electrum wallets use).
import { groestl512d } from '../core/groestl.mjs';
import { hash160, b58check, b58uncheck, segwitEncode, segwitDecode, cashEncode, cashDecode, scriptFor } from './btc-keys.mjs';

const P2PKH = 'p2pkh', P2SH_WPKH = 'p2sh-p2wpkh', P2WPKH = 'p2wpkh';

/** address from a public key, per type; returns {address, script} */
function makeAddress(profile, type, pubkey) {
  const h = hash160(pubkey);
  if (type === P2WPKH) return { address: segwitEncode(profile.hrp, 0, h), script: scriptFor('p2wpkh', h) };
  if (type === P2SH_WPKH) {
    const redeem = scriptFor('p2wpkh', h), sh = hash160(redeem);
    return { address: b58check(Buffer.from([profile.p2sh, ...sh]), profile.check), script: scriptFor('p2sh', sh) };
  }
  if (profile.cash) return { address: cashEncode(profile.cash, 0, h), script: scriptFor('p2pkh', h) };
  return { address: b58check(Buffer.from([profile.p2pkh, ...h]), profile.check), script: scriptFor('p2pkh', h) };
}

/** any receiving address a person typed (e.g. for a refund) -> {address, script}; throws with a plain message */
function readAddress(profile, input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Please enter an address.');
  const bad = () => new Error(`That is not a valid ${profile.name} address (a character may be wrong or missing).`);
  if (profile.hrp && s.toLowerCase().startsWith(profile.hrp + '1')) {
    let d; try { d = segwitDecode(profile.hrp, s); } catch { throw bad(); }
    const type = d.version === 0 ? (d.program.length === 20 ? 'p2wpkh' : 'p2wsh') : d.version === 1 && d.program.length === 32 ? 'p2tr' : null;
    if (!type) throw bad();
    return { address: s.toLowerCase(), script: scriptFor(type, d.program) };
  }
  if (profile.cash && (s.includes(':') || /^[qp][0-9a-z]{40,}$/i.test(s))) {
    let d; try { d = cashDecode(profile.cash, s); } catch { throw bad(); }
    return { address: cashEncode(profile.cash, d.type, d.hash), script: scriptFor(d.type === 0 ? 'p2pkh' : 'p2sh', d.hash) };
  }
  let raw; try { raw = b58uncheck(s, profile.check); } catch { throw bad(); }
  if (raw.length !== 21) throw bad();
  const h = raw.subarray(1);
  if (raw[0] === profile.p2pkh) return { address: profile.cash ? cashEncode(profile.cash, 0, h) : s, script: scriptFor('p2pkh', h) };
  if (raw[0] === profile.p2sh || (profile.p2shOld !== undefined && raw[0] === profile.p2shOld)) return { address: profile.cash ? cashEncode(profile.cash, 1, h) : s, script: scriptFor('p2sh', h) };
  throw new Error(`That address is not for ${profile.name}.`);
}

/** the address a scriptPubKey pays to (null for anything unusual) */
function scriptToAddress(profile, script) {
  const h = script.toString('hex');
  let m;
  if ((m = h.match(/^76a914([0-9a-f]{40})88ac$/))) return profile.cash ? cashEncode(profile.cash, 0, Buffer.from(m[1], 'hex')) : b58check(Buffer.from([profile.p2pkh, ...Buffer.from(m[1], 'hex')]), profile.check);
  if (profile.cash && (m = h.match(/^aa20([0-9a-f]{64})87$/))) return cashEncode(profile.cash, 1, Buffer.from(m[1], 'hex'));
  if ((m = h.match(/^a914([0-9a-f]{40})87$/))) return profile.cash ? cashEncode(profile.cash, 1, Buffer.from(m[1], 'hex')) : b58check(Buffer.from([profile.p2sh, ...Buffer.from(m[1], 'hex')]), profile.check);
  if (profile.hrp && (m = h.match(/^0014([0-9a-f]{40})$|^0020([0-9a-f]{64})$/))) return segwitEncode(profile.hrp, 0, Buffer.from(m[1] || m[2], 'hex'));
  if (profile.hrp && (m = h.match(/^5120([0-9a-f]{64})$/))) return segwitEncode(profile.hrp, 1, Buffer.from(m[1], 'hex'));
  return null;
}

// Electrum servers: TLS "host:port". Several per coin; two answering servers are compared before a payment counts.
export const PROFILES = {
  BTC: {
    id: 'BTC', name: 'Bitcoin', unitName: 'sat', decimals: 8, hrp: 'bc', p2pkh: 0x00, p2sh: 0x05, scheme: 'bitcoin',
    versions: { '04b24746': P2WPKH, '049d7cb2': P2SH_WPKH, '0488b21e': P2PKH },
    explorer: 'https://mempool.space/tx/', minutesPerBlock: 10, depth: (usd) => (usd <= 500 ? 1 : usd <= 5000 ? 2 : 3),
    servers: ['electrum.blockstream.info:50002', 'fortress.qtornado.com:443', 'electrum.emzy.de:50002', 'bitcoin.aranguren.org:50002', 'electrum.bitaroo.net:50002'],
    testnet: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4, versions: { '045f1cf6': P2WPKH, '044a5262': P2SH_WPKH, '043587cf': P2PKH }, explorer: 'https://mempool.space/testnet/tx/', servers: ['electrum.blockstream.info:60002', 'testnet.aranguren.org:51002'] },
  },
  LTC: {
    id: 'LTC', name: 'Litecoin', unitName: 'litoshi', decimals: 8, hrp: 'ltc', p2pkh: 0x30, p2sh: 0x32, p2shOld: 0x05, scheme: 'litecoin',
    // Trust Wallet exports zpub for Litecoin; Electrum-LTC uses Ltub/Mtub; some wallets use plain xpub
    versions: { '04b24746': P2WPKH, '01b26ef6': P2SH_WPKH, '019da462': P2PKH, '0488b21e': P2PKH },
    explorer: 'https://litecoinspace.org/tx/', minutesPerBlock: 2.5, depth: (usd) => (usd <= 500 ? 2 : usd <= 5000 ? 4 : 6),
    servers: ['electrum-ltc.bysh.me:50002', 'backup.electrum-ltc.org:443', 'electrum.ltc.xurious.com:50002'],
    testnet: { hrp: 'tltc', p2pkh: 0x6f, p2sh: 0x3a, versions: { '045f1cf6': P2WPKH, '043587cf': P2PKH }, explorer: 'https://litecoinspace.org/testnet/tx/', servers: ['electrum.ltc.xurious.com:51002'] },
  },
  BCH: {
    id: 'BCH', name: 'Bitcoin Cash', unitName: 'sat', decimals: 8, cash: 'bitcoincash', p2pkh: 0x00, p2sh: 0x05, scheme: '',
    versions: { '0488b21e': P2PKH },
    explorer: 'https://blockchair.com/bitcoin-cash/transaction/', minutesPerBlock: 10, depth: (usd) => (usd <= 500 ? 1 : usd <= 5000 ? 2 : 3),
    servers: ['bch.imaginary.cash:50002', 'electroncash.dk:50002', 'bch.loping.net:50002', 'electrum.imaginary.cash:50002'],
    testnet: { cash: 'bchtest', p2pkh: 0x6f, p2sh: 0xc4, versions: { '043587cf': P2PKH }, explorer: 'https://tbch.loping.net/tx/', servers: ['blackie.c3-soft.com:60002'] },
  },
  GRS: {
    id: 'GRS', name: 'Groestlcoin', unitName: 'gro', decimals: 8, hrp: 'grs', p2pkh: 36, p2sh: 5, scheme: 'groestlcoin',
    check: groestl512d,   // Groestlcoin's base58 checksums use Groestl-512 (twice) instead of SHA-256
    versions: { '04b24746': P2WPKH, '049d7cb2': P2SH_WPKH, '0488b21e': P2PKH },
    explorer: 'https://chainz.cryptoid.info/grs/tx.dws?', minutesPerBlock: 1, depth: (usd) => (usd <= 500 ? 5 : usd <= 5000 ? 10 : 20),
    servers: ['electrum1.groestlcoin.org:50002', 'electrum2.groestlcoin.org:50002'],
  },
};

export function profileFor(id, network) {
  const base = PROFILES[id];
  if (!base) throw new Error('unknown coin ' + id);
  return network === 'testnet' && base.testnet ? { ...base, ...base.testnet, network } : { ...base, network: 'mainnet' };
}
export { makeAddress, readAddress, scriptToAddress };
