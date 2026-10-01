export function repositoryOf(url: unknown): { key: string; number: number | null } | null;
export function prRefFromUrl(url: unknown): string | null;
export function commitRefFromUrl(repositoryUrl: unknown, sha: unknown): string | null;
