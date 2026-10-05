const hash = (value, length) =>
  typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
function installedTarget(target) {
  return (
    target &&
    target.installedOnRequiredTargets === true &&
    hash(target.sourceCommit, 40) &&
    hash(target.verificationCommit, 40) &&
    hash(target.artifactSeal, 64) &&
    hash(target.asarSha256, 64) &&
    typeof target.version === "string"
  );
}
function publicFrame(frame, target) {
  if (!frame || typeof frame !== "object") return false;
  const text = ["id", "title", "alt", "caption", "src"].every(
    (key) => typeof frame[key] === "string" && frame[key].trim().length > 0,
  );
  const identity = [
    "sourceCommit",
    "verificationCommit",
    "artifactSeal",
    "asarSha256",
    "version",
  ].every((key) => frame[key] === target[key]);
  const host = ["mac-mini", "macbook-pro"].includes(frame.capturedOn);
  const capturedAt =
    typeof frame.capturedAt === "string" && Number.isFinite(Date.parse(frame.capturedAt));
  const kind =
    frame.kind === undefined ||
    ["desktop-app", "compact-web", "native-mobile"].includes(frame.kind);
  return (
    text &&
    identity &&
    host &&
    capturedAt &&
    hash(frame.sha256, 64) &&
    kind &&
    /^assets\/captures\/[a-z0-9-]+\.(png|webp)$/.test(frame.src) &&
    frame.actualCapture === true &&
    frame.installedCapture === true &&
    frame.publicSafe === true &&
    Number.isInteger(frame.width) &&
    frame.width > 0 &&
    Number.isInteger(frame.height) &&
    frame.height > 0
  );
}
// Inventory validation is not installation or review attestation. Delivery pins actual
// approved/installed bytes at capture time; no stale candidate seal lives in this code.
export function acceptedFrames(value) {
  if (
    value?.status !== "verified" ||
    !installedTarget(value?.target) ||
    !Array.isArray(value.frames)
  )
    return [];
  return value.frames.filter((frame) => publicFrame(frame, value.target));
}
