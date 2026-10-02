/** Presentation only: retain the original excerpt for inspection. Never infer status. */
export function readableUpdate(text: string, references?: ReadonlyMap<string, string>) {
  const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
  const markers = new RegExp("^\\s*[A-Z][A-Z0-9_]{3,}\\s+(?:" + uuid + "|[a-f0-9]{64})\\s*$", "gm");
  return text
    .replace(markers, "")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(
      new RegExp(uuid, "gi"),
      (value) => references?.get(value.toLowerCase()) ?? "[reference]",
    )
    .replace(/\b[a-f0-9]{64}\b/gi, "[fingerprint]")
    .trim();
}
