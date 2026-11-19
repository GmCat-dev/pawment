# Contributing

Thanks for helping! Pawment is **beta software, still under development**, so ideas and bug reports are very welcome.

- **Bugs and ideas:** open an issue. For anything security-related, use private reporting instead (see SECURITY.md).
- **Code:** keep it small and dependency-free (Node.js built-ins only; the Cardano wallet library is the one optional
  exception). Run `npm test` before sending a pull request, and add a test for what you change.
- **New coins:** one plug-in per chain family in `chains/`, with test vectors from a reference implementation in
  `test/fixtures/`. Watch-only only: Pawment never asks for keys that can spend.
- **Wording:** plain language for buyers and shop owners; confirmations and messages appear inside the page, never in
  the browser's own pop-up boxes.

By contributing you agree that your contribution is licensed under the AGPL-3.0 and may also be included in the
commercial licence GmCat offers (see COMMERCIAL.md).
