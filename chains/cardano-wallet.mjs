// Wallet "Pay" button for Cardano (CIP-30: Eternl, Lace, Yoroi, Typhon, Vespr, …).
// The buyer's wallet hands over its spendable coins (UTxOs) and change address; the exact payment transaction is built
// here; the wallet shows it to the buyer and signs it (keys never leave the wallet); the signed transaction goes to the
// network through the wallet and, as a backup, through Koios. Needs @emurgo/cardano-serialization-lib-nodejs (optional:
// without it the button simply isn't offered and QR / copy still work).
import { createRequire } from 'node:module';

let C = null;
try { C = createRequire(import.meta.url)('@emurgo/cardano-serialization-lib-nodejs'); } catch { /* optional */ }

const KOIOS = { mainnet: 'https://api.koios.rest/api/v1', testnet: 'https://preprod.koios.rest/api/v1' };
const BUILT_TTL = 20 * 60 * 1000;   // a built transaction can be signed for this long
const MAX_UTXOS = 500;

export function createWalletPay({ network = 'mainnet', fetchJson, koios = KOIOS[network], post = fetch, log = console.log, source = null }) {
  // with a shared Cardano source, Blockfrost stands in whenever Koios is busy
  const pick = source ? source.pick : (viaKoios) => viaKoios();
  let params = null, paramsAt = 0;
  const built = new Map();   // tx body hash -> {order, at, hex}
  const B = (n) => C.BigNum.from_str(String(n));

  async function protocol() {
    if (params && Date.now() - paramsAt < 3600_000) return params;
    const p = await pick(async () => (await fetchJson(koios + '/epoch_params?limit=1'))[0], () => source.blockfrost('/epochs/latest/parameters'));
    params = p; paramsAt = Date.now();
    return p;
  }
  function config(p) {
    const ref = Number(p.min_fee_ref_script_cost_per_byte ?? 15);
    return C.TransactionBuilderConfigBuilder.new()
      .fee_algo(C.LinearFee.new(B(p.min_fee_a), B(p.min_fee_b)))
      .pool_deposit(B(p.pool_deposit)).key_deposit(B(p.key_deposit))
      .max_value_size(Number(p.max_val_size)).max_tx_size(Number(p.max_tx_size))
      .coins_per_utxo_byte(B(p.coins_per_utxo_size))
      .ref_script_coins_per_byte(C.UnitInterval.new(B(Math.round(ref * 1000)), B(1000)))
      .prefer_pure_change(true)
      .build();
  }

  return {
    available: () => Boolean(C),
    networkId: network === 'mainnet' ? 1 : 0,
    /**
     * Build the payment. utxos: CIP-30 getUtxos() hex list; change: CIP-30 getChangeAddress() hex.
     * Returns {tx (unsigned hex), fee (lovelace), extra_ada (lovelace riding along with a token)}.
     */
    async build({ order, address, unit, amount, utxos, change, tip }) {
      if (!C) throw Object.assign(new Error('Paying from a wallet is not set up here. Please use the QR code or copy the address.'), { code: 'no_wallet_pay' });
      if (!Array.isArray(utxos) || !utxos.length) throw Object.assign(new Error('Your wallet has no coins to pay with on this account.'), { code: 'empty' });
      if (utxos.length > MAX_UTXOS) throw Object.assign(new Error('Your wallet has too many separate coins to pay this way. Please use the QR code.'), { code: 'too_many' });
      const p = await protocol();
      const tb = C.TransactionBuilder.new(config(p));
      const to = C.Address.from_bech32(address);
      let out, extra = 0n;
      if (unit === 'lovelace') out = C.TransactionOutput.new(to, C.Value.new(B(amount)));
      else {
        const ma = C.MultiAsset.new(), assets = C.Assets.new();
        assets.insert(C.AssetName.new(Buffer.from(unit.slice(56), 'hex')), B(amount));
        ma.insert(C.ScriptHash.from_hex(unit.slice(0, 56)), assets);
        out = C.TransactionOutputBuilder.new().with_address(to).next()
          .with_asset_and_min_required_coin_by_utxo_cost(ma, C.DataCost.new_coins_per_byte(B(p.coins_per_utxo_size))).build();
        extra = BigInt(out.amount().coin().to_str());
      }
      tb.add_output(out);
      const set = C.TransactionUnspentOutputs.new();
      try { for (const h of utxos) set.add(C.TransactionUnspentOutput.from_hex(String(h))); } catch { throw Object.assign(new Error('Your wallet sent something we could not read.'), { code: 'bad_utxo' }); }
      let changeAddr;
      try { changeAddr = C.Address.from_hex(String(change)); } catch { throw Object.assign(new Error('Your wallet sent something we could not read.'), { code: 'bad_change' }); }
      if (changeAddr.network_id() !== (network === 'mainnet' ? 1 : 0)) throw Object.assign(new Error(network === 'mainnet' ? 'Your wallet is on a test network. Switch it to the main Cardano network.' : 'Your wallet is on the main network; this is a test checkout.'), { code: 'network' });
      try {
        tb.add_inputs_from(set, C.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      } catch {
        throw Object.assign(new Error('There isn\'t enough in this wallet for this payment and its network fee.'), { code: 'funds' });
      }
      const slot = tip?.slot ?? await pick(async () => Number((await fetchJson(koios + '/tip'))[0].abs_slot), async () => Number((await source.blockfrost('/blocks/latest')).slot));
      tb.set_ttl_bignum(B(slot + 3600));   // about an hour to sign
      try { tb.add_change_if_needed(changeAddr); } catch { throw Object.assign(new Error('There isn\'t enough in this wallet for this payment and its network fee.'), { code: 'funds' }); }
      const tx = tb.build_tx();
      const hash = C.FixedTransaction.from_hex(tx.to_hex()).transaction_hash().to_hex();
      const now = Date.now();
      for (const [k, v] of built) if (now - v.at > BUILT_TTL) built.delete(k);
      built.set(hash, { order, at: now });
      return { tx: tx.to_hex(), hash, fee: tb.get_fee_if_set()?.to_str() || '0', extra_ada: extra.toString() };
    },
    /** Put the wallet's signature on the transaction we built (same bytes, so the hash the wallet signed stays valid). */
    finish({ order, tx, witness }) {
      if (!C) throw new Error('not available');
      let ft;
      try { ft = C.FixedTransaction.from_hex(String(tx)); } catch { throw Object.assign(new Error('That is not a transaction we made.'), { code: 'bad_tx' }); }
      const hash = ft.transaction_hash().to_hex();
      const b = built.get(hash);
      if (!b || b.order !== order) throw Object.assign(new Error('This payment has run out of time. Please press Pay again.'), { code: 'stale' });
      let ws;
      try { ws = C.TransactionWitnessSet.from_hex(String(witness)); } catch { throw Object.assign(new Error('Your wallet did not send a signature.'), { code: 'bad_witness' }); }
      if (!ws.vkeys() || ws.vkeys().len() === 0) throw Object.assign(new Error('Your wallet did not send a signature.'), { code: 'bad_witness' });
      ft.set_witness_set(ws.to_bytes());
      return { signed: ft.to_hex(), hash };
    },
    /** Send a signed transaction through Koios (backup for wallets that don't send it themselves). */
    async submit(signedHex) {
      const url = source && source.koiosPaused() && source.bfKey() ? source.blockfrostUrl + '/tx/submit' : koios + '/submittx';
      const r = await post(url, { method: 'POST', headers: { 'content-type': 'application/cbor', ...(url.includes('blockfrost') ? { project_id: source.bfKey() } : {}) }, body: Buffer.from(signedHex, 'hex'), signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (!r.ok) log('backup send: network answered ' + r.status + ' ' + text.slice(0, 160));
      if (!r.ok && !/already|BadInputsUTxO.*(spent)?/i.test(text)) { log('submit: ' + r.status + ' ' + text.slice(0, 200)); throw new Error('The network did not accept the payment: ' + text.slice(0, 160)); }
      return true;
    },
    _lib: () => C,
  };
}
