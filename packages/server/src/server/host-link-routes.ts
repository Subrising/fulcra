import express, { type Express, type RequestHandler } from "express";
import { ZodError } from "zod";
import { extractHttpBearerToken } from "./auth.js";
import { HostLinkError, type HostLinks } from "./host-links.js";

/** Mount before daemon auth. Every request authenticates through its narrower endpoint. */
export function mountHostLinkRoutes(app: Express, service: () => HostLinks | null): void {
  for (const operation of ["dispatch", "receive", "worker"] as const) {
    const handle: RequestHandler = (req, res) => {
      const hostLinks = service();
      if (!hostLinks) {
        res.status(503).json({ error: "Host links are not ready." });
        return;
      }
      if (req.header("origin")) {
        res.status(403).json({ error: "Browser requests are refused." });
        return;
      }
      const token = extractHttpBearerToken(req.header("authorization"));
      void hostLinks[operation](token, req.body).then(
        (receipt) => res.json(receipt),
        (error: unknown) => {
          if (res.headersSent) return;
          if (error instanceof ZodError) {
            res.status(400).json({ error: "Invalid host-link request." });
            return;
          }
          if (error instanceof HostLinkError) {
            const status = error.code === "refused" ? 403 : 409;
            res.status(status).json({ code: error.code, error: error.message });
            return;
          }
          res
            .status(503)
            .json({ error: "Host-link admission failed. Retain the request identity." });
        },
      );
    };
    app.post(`/api/host-links/${operation}`, express.json({ limit: "256kb" }), handle);
  }
}
