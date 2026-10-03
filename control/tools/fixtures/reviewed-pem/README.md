# Exact reviewed PEM-marker fixtures

These unmodified upstream files exercise the three exact entries in `tools/reviewed-pem-markers.json`: dotenv 17.3.1 `README-es.md` and jose 6.2.2 `dist/webapi/key/import.js`. Their SHA-256, offsets, lines and contexts must continue matching that reviewed list. Both upstream MIT licenses are included. These are truncated documentation examples and a parser header string, not credentials.

The test creates a minimal uncompressed ASAR fixture itself. It needs neither a sibling product checkout nor `@electron/asar`, and still rejects changed bytes and changed review fields. The separate `packaged-asar.integration.test.mjs` covers output from the real packaging dependency; this fixture test makes no packaging claim.

The dotenv fixture uses base64 encoding to preserve the upstream Markdown bytes through repository format and whitespace hooks; previous automatic Markdown formatting changed its hash and invalidated the positive oracle. Package virtual path and approved hash/context remain unchanged.
