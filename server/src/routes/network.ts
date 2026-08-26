import { Hono } from "hono";
import { phoneLink } from "../services/network";

const app = new Hono();

/**
 * Computed per request, never cached: the address changes with the network, and
 * a remembered one sends you to a machine that is no longer there.
 */
app.get("/phone", async (c) => c.json(await phoneLink()));

export default app;
