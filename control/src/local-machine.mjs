import fs from 'node:fs';
export const localFile = name => new URL('../../local/' + name, import.meta.url);
export function localJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(localFile(name), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Populate local/${name} with this installation's reviewed configuration`, { cause: error });
  }
}
export function localMachine(key) {
  const value = localJson('machine-values.json', {})[key];
  if (value === undefined) return '/path/to/unconfigured/' + key;
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) throw new Error('Invalid local machine path: ' + key);
  return value;
}
