/**
 * Platform admins: Octillion staff who run /admin across every customer, as opposed to an account's own admins (Clerk
 * organization role admin, managing their team on /app). They sign in with Clerk (password, Google, Microsoft, GitHub,
 * whatever the Clerk instance allows); being a platform admin is configured, not stored in the database or the source:
 *
 *   OCTILLION_PLATFORM_ADMINS  comma-separated addresses or *@domain entries; Clerk must have verified the address
 *   (or the Clerk user has public_metadata.platform_admin = true, set in the Clerk dashboard)
 *   OCTILLION_ADMIN_TOKEN      still accepted as a bearer token, for scripts and the key vault / population APIs
 *
 * Requests authenticated by Clerk's session cookie that change something must carry `X-Octillion-Admin: 1`, which a
 * cross-site form cannot send, so the cookie cannot be ridden (CSRF). Bearer-token requests need no extra header.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearer } from "./auth.js";
import { clerkEnabled, platformAdminFor } from "./clerk.js";
import { clerkSession } from "./session.js";

function tokenOk(t: string | null) {
  const want = process.env.OCTILLION_ADMIN_TOKEN;
  if (!want || !t) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(t), h(want));
}

/** Guards /api/admin/*: the admin token, or a Clerk session of a platform admin (plus the CSRF header on cookie writes). */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (tokenOk(bearer(req.headers.authorization))) return next();
  const s = await clerkSession(req);
  if (!s) return void res.status(401).json({ error: "Sign in as a platform admin", sign_in_url: "/sign-in" });
  const { email, isAdmin } = await platformAdminFor(s.userId).catch(() => ({ email: null, isAdmin: false }));
  if (!isAdmin) return void res.status(403).json({ error: `${email ?? "This account"} is not a platform admin` });
  if (s.viaCookie && req.method !== "GET" && req.get("x-octillion-admin") !== "1") return void res.status(403).json({ error: "Missing X-Octillion-Admin header" });
  res.locals.adminActor = email ?? s.userId;
  next();
}

/** The name admin changes are logged under: the signed-in email, else the X-Admin-Actor label sent with the token. */
export const adminActor = (req: Request, res: Response) =>
  (res.locals.adminActor as string | undefined) ?? (String(req.get("x-admin-actor") ?? "admin").trim().slice(0, 80) || "admin");

export function adminAuthRouter() {
  const r = express.Router();
  // For the admin UI: who is signed in and whether they may use /admin. Sign-in and sign-out are Clerk's.
  r.get("/admin/session", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const s = clerkEnabled() ? await clerkSession(req) : null;
    if (!s) return void res.json({ signed_in: false, email: null, is_platform_admin: false, clerk: clerkEnabled() });
    const { email, isAdmin } = await platformAdminFor(s.userId).catch(() => ({ email: null, isAdmin: false }));
    res.json({ signed_in: true, user_id: s.userId, email, is_platform_admin: isAdmin, clerk: true });
  });
  return r;
}
