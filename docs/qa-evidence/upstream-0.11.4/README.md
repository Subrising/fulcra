# Provider intake browser evidence

Captured with existing Chrome and an isolated daemon on 16 October 2026.
The browser uses synthetic provider state and touch input.

| Viewport | Controls checked | Small targets | Clipped text | Overflow | Overlap |
| -------- | ---------------: | ------------: | -----------: | -------: | ------: |
| 375×812  |              102 |             0 |            0 |        0 |       0 |
| 768×1024 |              118 |             0 |            0 |        0 |       0 |
| 1440×900 |              116 |             0 |            0 |        0 |       0 |
| 812×375  |              107 |             0 |            0 |        0 |       0 |

Each viewport has provider-list and catalog PNGs. The list uses scrolling at short heights.
The measurements reject controls below 48×48 pixels, with 0.5-pixel rounding tolerance.
No viewport scrolls sideways. Inspect the full results in [provider-layout.json](provider-layout.json).

The functional cases cover Add, opt-in Hoplite, Remove, plugin ownership, update errors, and light/dark themes.
An observed long provider error exposed clipped text. Provider errors now wrap without a line limit.

Follow [the provider intake check](../../../.agents/skills/verify-provider-intake/SKILL.md) to repeat these checks.
These results do not prove native device or packaged Electron behavior.
