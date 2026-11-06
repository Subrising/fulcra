<<<<<<< HEAD
// Browser component tests never read or write the system clipboard.
export const setStringAsync = async (_value: string) => undefined;
export const getStringAsync = async () => "";
=======
// The package ships JSX in .js files, which the dependency optimizer cannot parse.
export async function setStringAsync(): Promise<boolean> {
  return true;
}
export async function getStringAsync(): Promise<string> {
  return "";
}
export async function hasStringAsync(): Promise<boolean> {
  return false;
}
>>>>>>> refs/remotes/upstream/tags/v0.14.0
