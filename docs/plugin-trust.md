# Desktop plugin trust

Plugins bundled with Fulcra run with owner rights on this Mac. The Fulcra desktop app runs plugin code only when it is byte-identical to the corresponding plugin bundled with this app, whether supplied by this Mac’s own host or any other host.

The desktop app checks each client bundle's SHA-256 against the build-generated runtime manifest in its own bundled resources before evaluating it. The check applies to every connected host; a claimed local identity cannot bypass it. Missing or mismatched pins show “Plugin not trusted on this Mac”. Updating a host's plugin alone cannot authorize new code on this Mac: the app must ship the matching bundle. Bundled plugins continue to share the app's main world and owner-authenticated connection. Full isolation remains follow-up L21.

A locally installed or example plugin is also refused unless it matches the bundled pin. A refused plugin keeps an untrusted sidebar row that opens the host app’s explanation and update instructions; refused code is never evaluated. Align the app and host to the same Fulcra build. Same-source distribution client builds use a stable compilation root so random staging directories do not change their pins.
