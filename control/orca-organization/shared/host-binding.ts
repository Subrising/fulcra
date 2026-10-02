import { z } from "zod";
export const nativeServerId = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
export const DEFAULT_NATIVE_HOSTS: Record<string, string | null> = {};
export const nativeHostBindings = z
  .record(z.string().min(1).max(256), nativeServerId.nullable())
  .refine((value) => {
    const ids = Object.values(value).filter(Boolean);
    return new Set(ids).size === ids.length;
  });
