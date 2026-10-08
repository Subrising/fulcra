# Native iOS text geometry regression

Run on the Namespace Mac with a fresh simulator development build. Use the PID
returned by `xcrun simctl launch <your-task-simulator-UDID> sh.paseo.debug`.
Attach only to your task's app, while no device replay is running:

```sh
PASEO_NATIVE_TEXT_REFLOW_PID=12345 \
PASEO_NATIVE_TEXT_REFLOW_LOG=/Volumes/devbox/workspace/native-text-reflow.log \
bash packages/app/e2e/mobile/native-text-reflow/ios.sh
```

The probe constructs the installed `RNUITextView`, fills its real UIKit text view,
and resizes its content container from 500 to 240 and back to 500 points. It
asserts the inner frame follows both widths and the same selection survives.
It then recycles the view the way Fabric's pool does and remounts it 30 points
wider and at the same size; the inner frame must still match the container.
A zeroed frame on recycle comes back 30 or 0 points wide, which is the narrow
column seen under a streamed table.
It uses public UIView/UITextView operations, without mocking React Native.
LLDB detaches after the probe. An assertion failure or evaluation error fails the
shell command; the log distinguishes them.

This covers native container resizing and selection retention. It does not cover
Fabric event delivery, chat row height, reader anchoring, or the on-screen copy
menu. Those require the real chat journey: read an older multiline response,
open/close Explorer, resize/rotate, inspect complete paragraphs and bullets,
retain expanded/collapsed details, and check a stationary reader's position.
Accessibility exposes full text even when glyphs are clipped, so a text wait
alone does not verify that journey.

For the phone chat check, stream a reply with bold lead-ins (`**What I see:** …`),
bullet items that start with bold text, a table followed by a paragraph, and plain
paragraphs. Check it at 375 and 390 points wide, in light and dark mode, and at the
largest Dynamic Type size. Switch chats and come back, so recycled views remount.
Fail if a paragraph or list item shows a column narrower than its row, or cut words.
