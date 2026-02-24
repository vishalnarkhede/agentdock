import { Hono } from "hono";
import { getRepos } from "../services/config";

const app = new Hono();

app.get("/", (c) => {
  const repos = getRepos();
  return c.json(repos);
});

export default app;
