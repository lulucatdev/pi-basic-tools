# Vendored diff subset

This directory vendors the ESM line-diff implementation from `diff@8.0.2` (`libesm/diff/base.js`, `libesm/diff/line.js`, and `libesm/util/params.js`).

It is bundled so `pi update git:github.com/lulucatdev/pi-basic-tools` does not depend on `npm install` creating `node_modules/diff`.

Upstream: https://github.com/kpdecker/jsdiff
License: BSD-3-Clause, see `LICENSE`.
