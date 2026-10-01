import { portable } from '../portable-config.mjs';
export const localHostName = () => portable.localHost.name;
export const configuredHost = name => [portable.localHost, ...portable.hosts].some(h => h.name === name);
// Remote configuration is retained for discovery/navigation; remote execution is not shipped in v0.2.
export function localNative(local) {
  return new Proxy(local, { get(target, key) {
    if (key === 'project') return row => ({ ...row, host: localHostName() });
    if (key === 'create') return (input, options) => {
      if (input.host && input.host !== localHostName()) throw Error('Remote host execution is outside v0.2; select localHost.name');
      return target.create(input, options);
    };
    if (key === 'attach' || key === 'assertLocal') return () => {};
    if (key === 'route' || key === 'status') return () => null;
    if (key === 'reconcile') return async () => {};
    if (key === 'children') return () => [];
    if (key === 'activity' || key === 'activityPage') return () => { throw Error('Remote activity is outside v0.2'); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
