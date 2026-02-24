import { Hono } from "hono";
import { getDbShards, getDbShard, addDbShard, removeDbShard } from "../services/config";
import type { DbShard } from "../types";

const app = new Hono();

// ─── Read-only validation ───

function validateReadOnly(query: string): { ok: boolean; reason?: string } {
  // Strip comments
  const stripped = query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  // Check each statement (split on semicolons)
  for (const raw of stripped.split(";")) {
    const stmt = raw.trim();
    if (!stmt) continue;

    const upper = stmt.toUpperCase();
    const forbidden = [
      /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/,
      /\bINTO\s+OUTFILE\b/,
      /\bLOAD\s+DATA\b/,
    ];
    for (const pattern of forbidden) {
      if (pattern.test(upper)) {
        return { ok: false, reason: `Forbidden statement: ${stmt.slice(0, 60)}...` };
      }
    }

    // Must start with an allowed keyword
    const firstWord = upper.match(/^\s*(\w+)/)?.[1];
    if (!["SELECT", "WITH", "EXPLAIN", "SHOW", "SET"].includes(firstWord || "")) {
      return { ok: false, reason: `Query must start with SELECT, WITH, EXPLAIN, or SHOW (got: ${firstWord})` };
    }
  }

  return { ok: true };
}

// ─── Query execution ───

async function runQuery(shard: DbShard, query: string): Promise<{ rows: string; rowCount: number; duration: number }> {
  // Auto-add LIMIT if none present
  const upperQuery = query.toUpperCase();
  const needsLimit = !upperQuery.includes("LIMIT") && upperQuery.trimStart().startsWith("SELECT");
  const limitedQuery = needsLimit ? `${query.replace(/;\s*$/, "")} LIMIT 1000` : query;

  const fullQuery = `SET statement_timeout = '120s'; ${limitedQuery}`;

  const start = Date.now();
  const proc = Bun.spawn(
    [
      "psql",
      "-h", shard.host,
      "-p", String(shard.port),
      "-U", shard.user,
      "-d", shard.database,
      "--csv",
      "-c", fullQuery,
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: shard.password,
        PGSSLMODE: shard.sslmode || "require",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const duration = Date.now() - start;

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `psql exited with code ${exitCode}`);
  }

  // Count rows (CSV lines minus header, minus empty trailing line)
  const lines = stdout.trim().split("\n");
  const rowCount = Math.max(0, lines.length - 1); // subtract header

  return { rows: stdout.trim(), rowCount, duration };
}

// ─── Routes ───

// List shards (passwords redacted)
app.get("/shards", (c) => {
  const shards = getDbShards().map(({ password, ...rest }) => rest);
  return c.json(shards);
});

// Add/update a shard
app.post("/shards", async (c) => {
  const body = (await c.req.json()) as DbShard;
  if (!body.name || !body.host || !body.port || !body.database || !body.user || !body.password) {
    return c.json({ error: "Missing required fields: name, host, port, database, user, password" }, 400);
  }
  addDbShard(body);
  return c.json({ ok: true }, 201);
});

// Delete a shard
app.delete("/shards/:name", (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  removeDbShard(name);
  return c.json({ ok: true });
});

// Test connectivity
app.get("/test/:name", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const shard = getDbShard(name);
  if (!shard) return c.json({ ok: false, error: "Shard not found" }, 404);

  try {
    const result = await runQuery(shard, "SELECT 1 AS ok");
    return c.json({ ok: true, duration: result.duration });
  } catch (err: any) {
    return c.json({ ok: false, error: err.message });
  }
});

// Execute a read-only query
app.post("/query", async (c) => {
  const body = (await c.req.json()) as { shard: string; query: string };
  if (!body.shard || !body.query) {
    return c.json({ error: "Missing required fields: shard, query" }, 400);
  }

  const shard = getDbShard(body.shard);
  if (!shard) return c.json({ error: `Shard '${body.shard}' not found` }, 404);

  const validation = validateReadOnly(body.query);
  if (!validation.ok) {
    return c.json({ error: `Read-only violation: ${validation.reason}` }, 403);
  }

  try {
    const result = await runQuery(shard, body.query);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
