/**
 * The product name people see: window title, macOS app menu, About panel, notifications.
 *
 * `app.setName()` in main.ts uses the same name, which also names the userData directory; tests can
 * override that one (PASEO_TEST_APP_NAME), so show this constant instead of `app.getName()` wherever
 * the name is displayed.
 */
export const APP_DISPLAY_NAME = "Fulcra";
