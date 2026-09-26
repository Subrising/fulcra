Example Architecture IR v1 documents used as test fixtures: `head.ir.json` and
`baseline.ir.json` are the hand-mapped Radius definition IRs from the reviewed Archify
delta example. Their JSON content is unchanged from the reviewed originals (upstream
SHA-256 `8eace209ecbd…` and `6afde3991f06…`); `head.ir.json` has been re-wrapped by the
repository formatter, so its bytes differ from the original while every value is equal.
They are data, not Archify code; the upstream MIT notice that accompanied the example is
kept beside them in `NOTICE-archify-LICENSE.txt`.

`change-base.ir.json` and `change-head.ir.json` are a made-up shop, before and after one change
(a search service added, a reports job removed, the orders service changed). The app's
comparison (`map-diff.ts`) is tested on this pair.
