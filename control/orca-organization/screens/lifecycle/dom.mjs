// Minimal DOM host for the real CleanupSurface. No live data or application access.
let values = [],
  index = 0,
  root;
export function useState(initial) {
  const n = index++;
  if (!(n in values)) values[n] = initial;
  return [
    values[n],
    (v) => {
      values[n] = typeof v === "function" ? v(values[n]) : v;
      render();
    },
  ];
}
export const Fragment = Symbol("fragment");
export function jsx(type, props) {
  return { type, props: props ?? {} };
}
export const jsxs = jsx;
export const View = "div",
  Text = "p",
  Pressable = "button",
  TextInput = "input",
  ScrollView = "scroll";
function node(v) {
  if (v == null || typeof v === "boolean") return document.createTextNode("");
  if (typeof v !== "object") return document.createTextNode(String(v));
  if (Array.isArray(v)) {
    const f = document.createDocumentFragment();
    v.forEach((x) => f.append(node(x)));
    return f;
  }
  if (v.type === Fragment) return node(v.props.children);
  if (typeof v.type === "function") return node(v.type(v.props));
  const p = v.props,
    el = document.createElement(v.type === "scroll" ? "div" : v.type);
  Object.assign(el.style, {
    boxSizing: "border-box",
    margin: "0",
    fontFamily: "system-ui",
    fontSize: "15px",
    borderStyle: "solid",
    borderWidth: "0",
  });
  if (["div", "scroll"].includes(v.type))
    Object.assign(el.style, { display: "flex", flexDirection: "column" });
  const style = { ...p.style, ...(v.type === "scroll" ? p.contentContainerStyle : {}) };
  if (v.type === "scroll")
    Object.assign(el.style, { height: "100vh", overflow: "auto", flexShrink: "0" });
  for (const [k, value] of Object.entries(style ?? {}))
    el.style[k] =
      typeof value === "number" && !["opacity", "fontWeight", "flex", "flexShrink"].includes(k)
        ? `${value}px`
        : value;
  if (p.accessibilityRole) el.setAttribute("role", p.accessibilityRole);
  if (p.accessibilityLabel) el.setAttribute("aria-label", p.accessibilityLabel);
  if (p.disabled) el.disabled = true;
  if (p.onPress) el.onclick = p.onPress;
  if ("value" in p) {
    el.value = p.value;
    el.onchange = (e) => p.onChangeText(e.target.value);
  }
  el.append(node(p.children));
  return el;
}
export function mount(fn) {
  root = fn;
  render();
}
function render() {
  if (!root) return;
  index = 0;
  document.getElementById("root").replaceChildren(node(root()));
}
