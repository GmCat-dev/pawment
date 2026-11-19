# Receiving wallets

> **Beta software, still under development.** Check the first addresses against your wallet app before saving, and test
> each coin with a small amount first.

Pawment never needs a seed phrase, a spend key or any private key that can move coins. **If anything asks you to paste
one, stop.** It only needs something that lets it *see* payments: an extended public key (for fresh addresses per order)
or a plain address. The one exception is Monero, where seeing payments takes the **private view key**: it can only read
incoming payments, never spend (the spend key stays in your wallet).

**Use a wallet or account only for payments**, not your everyday one. Pawment hands out at most 15 unused fresh
addresses in a row (`gap_budget`), because wallet apps stop looking after 20 unused ones.

When you paste a key in the dashboard's **Wallet** tab, it shows the first addresses it will use. **Check that they match
the receive addresses in your wallet app** before you press "use this wallet". Every wallet change is logged and emailed
to you (when email alerts are set up).

| Coins | What to give | Where to find it |
|---|---|---|
| **Cardano** (ADA and tokens) | the **account public key** (`xpub1…` or `acct_xvk1…`) of a separate account | Eternl: add an account, then its details / "Export public key". Lace and most others show it in account settings. A single `addr1…` address also works (orders then told apart by exact amount). |
| **Bitcoin** (BTC) | an extended public key: `zpub` (bc1… addresses), `ypub` or `xpub` | Sparrow: Settings → Keystores. Electrum: Wallet → Information. Trust Wallet: Settings → Wallets → (i) → Export account public keys. |
| **Litecoin** (LTC) | `zpub`, `Ltub`, `Mtub` or `xpub` | Electrum-LTC: Wallet → Information. Trust Wallet as above. |
| **Bitcoin Cash** (BCH) | `xpub` | Electron Cash: Wallet → Information. |
| **Groestlcoin** (GRS) | `zpub`, `ypub` or `xpub` | Electrum-GRS: Wallet → Information. |
| **Ethereum, BNB Smart Chain, Polygon** (ETH, BNB, POL, USDT, USDC) | one ordinary `0x…` address (the same one works on all three) | Any wallet: MetaMask, Rabby, Trust Wallet… |
| **TRON** (TRX, USDT) | one ordinary `T…` address | TronLink, Trust Wallet… |
| **Monero** (XMR) | the **primary address** (starts with 4) and the **private view key** (64 characters), on two lines | Feather / Monero GUI: Wallet → Keys (or Settings → Seed & keys). The view key only lets Pawment see incoming payments. Never paste the spend key. |

## Why some coins use one address
Ethereum-family chains and TRON normally use one address per wallet, and making fresh ones would need keys that can
spend (to move the money on). Pawment doesn't do that. Instead each order on those chains asks for a slightly unique
amount (adding at most about one cent), and the checkout says "send the exact amount". Wallet "Pay" buttons fill the
exact amount in for the buyer.

## Test networks
With `"network": "testnet"` Pawment uses Cardano preprod, Bitcoin/Litecoin/Bitcoin Cash testnet, Sepolia, BNB testnet,
Polygon Amoy, TRON Nile and Monero stagenet. Test-network keys look different (`tpub`, `vpub`, `addr_test1…`), and you
must set your real wallets again when you switch to mainnet. Groestlcoin has no test network here.
