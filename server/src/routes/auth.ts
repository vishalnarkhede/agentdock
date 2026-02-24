import { Hono } from "hono";
import { createHash } from "crypto";
import { getAuthPassword, setAuthPassword } from "../services/config";

const app = new Hono();

function makeSessionToken(password: string): string {
  return createHash("sha256").update(`ad:${password}`).digest("hex");
}

export function verifyWsCookie(req: Request): boolean {
  const password = getAuthPassword();
  if (!password) return true; // no auth configured
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/ad_session=([^;]+)/);
  const token = match?.[1];
  return token === makeSessionToken(password);
}

export function authMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const password = getAuthPassword();
    // No password set — auth disabled, allow everything
    if (!password) return next();

    // Skip auth for login endpoint and password setup
    const path = new URL(c.req.url).pathname;
    if (path === "/api/auth/login" || path === "/api/auth/status") return next();

    const expected = makeSessionToken(password);

    // Check cookie (browser)
    const cookie = c.req.header("cookie") || "";
    const cookieMatch = cookie.match(/ad_session=([^;]+)/);
    if (cookieMatch?.[1] === expected) return next();

    // Check Authorization header (agents use AD_AUTH_TOKEN)
    const authHeader = c.req.header("authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    if (bearer && bearer === expected) return next();

    return c.json({ error: "Unauthorized" }, 401);
  };
}

// GET /api/auth/status — is auth enabled? is user logged in?
app.get("/status", (c) => {
  const password = getAuthPassword();
  if (!password) return c.json({ enabled: false, loggedIn: true });

  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/ad_session=([^;]+)/);
  const token = match?.[1];
  const expected = makeSessionToken(password);

  return c.json({ enabled: true, loggedIn: token === expected });
});

// POST /api/auth/login — validate password, set cookie
app.post("/login", async (c) => {
  const body = (await c.req.json()) as { password: string };
  const stored = getAuthPassword();

  if (!stored) return c.json({ error: "Auth not configured" }, 400);
  if (body.password !== stored) return c.json({ error: "Wrong password" }, 403);

  const token = makeSessionToken(stored);
  c.header("Set-Cookie", `ad_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return c.json({ ok: true });
});

// POST /api/auth/logout — clear cookie
app.post("/logout", (c) => {
  c.header("Set-Cookie", `ad_session=; Path=/; HttpOnly; Max-Age=0`);
  return c.json({ ok: true });
});

// PUT /api/auth/password — set or change password
app.put("/password", async (c) => {
  const body = (await c.req.json()) as { password: string };
  if (!body.password || body.password.length < 4) {
    return c.json({ error: "Password must be at least 4 characters" }, 400);
  }
  setAuthPassword(body.password);
  // Set session cookie so user stays logged in
  const token = makeSessionToken(body.password);
  c.header("Set-Cookie", `ad_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return c.json({ ok: true });
});

export default app;
