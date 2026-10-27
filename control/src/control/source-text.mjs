// Static source checks read formatted source. This view removes the line breaks, indentation and trailing commas that
// the formatter adds, so a check names the code and not its layout.
export const flat = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/,\s*([)\]}])/g, " $1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\s+;/g, ";");
