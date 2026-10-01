/**
 * The product name people see: window title, macOS app menu, About panel, notifications.
 *
 * `app.setName()` in main.ts deliberately keeps the older internal name, because Electron derives
 * the userData directory from it; changing that would strand every existing install's settings and
 * window state. Show this constant instead of `app.getName()` wherever the name is displayed.
 */
export const APP_DISPLAY_NAME = "Fulcra";
