export const PUBLIC_URL: "https://subrising.github.io/fulcra/";
export function prepareSite(options: {
  source?: string;
  output?: string;
  preview?: boolean;
}): Promise<{ publicUrl: string; preview: boolean; files: string[] }>;
