# Credits

Pawment is written by GmCat. It includes or uses:

- **QR Code Generator for JavaScript**, Copyright (c) 2009 Kazuhiko Arase, MIT licence (`public/assets/qrcode.js`,
  `public/admin/qrcode.js`). "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
- **@emurgo/cardano-serialization-lib-nodejs** (optional dependency, MIT licence) for building Cardano wallet transactions.
- **Design ideas from [Bitcart](https://github.com/bitcart/bitcart)** (MIT licence): watch-only extended public keys and
  Electrum-protocol servers for the Bitcoin family. Pawment's code is its own; no Bitcart code is included.
- Public facts and standards: BIP32/44/49/84 key derivation, bech32/bech32m, CashAddr, CIP-1852/CIP-19 (Cardano),
  EIP-55/EIP-1193/EIP-6963 (Ethereum), Monero subaddresses and view tags, the Groestl hash. Each was checked against
  reference implementations and published test vectors (see `test/fixtures/`).
- Token contract addresses and Cardano policy ids are taken from each issuer's own pages and cross-checked on-chain.

Thanks to the public blockchain services Pawment reads by default (Koios, Blockfrost, public Electrum servers,
publicnode, dRPC, 1RPC, TronGrid, TronStack and community Monero nodes) and the price sources (CoinGecko, Kraken,
DexScreener, Minswap pools).
