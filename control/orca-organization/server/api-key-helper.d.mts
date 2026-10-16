export function apiKeyHelperCommand(options: {
  root: string;
  id: string;
  session?: string | null;
  epoch?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string;
