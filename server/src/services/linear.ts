import { getLinearApiKey, getLinearTeamId } from "./config";
import type { LinearTicket } from "../types";

async function linearGql(query: string): Promise<any> {
  const apiKey = getLinearApiKey();
  if (!apiKey) throw new Error("Linear API key not configured");

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = (await res.json()) as any;
  if (data.errors) {
    throw new Error(data.errors[0]?.message || "Linear API error");
  }
  return data.data;
}

function parseTicketInput(input: string): { team: string; number: number } {
  // Handle URLs like https://linear.app/org/issue/PROJ-123/some-title
  const urlMatch = input.match(/issue\/([A-Z0-9]+-\d+)/i);
  if (urlMatch) input = urlMatch[1];

  // Handle identifiers like PROJ-123
  const match = input.trim().match(/^([A-Z0-9]+)-(\d+)$/i);
  if (!match) throw new Error(`Invalid ticket: "${input}". Expected format: PROJ-123 or a Linear URL`);
  return { team: match[1].toUpperCase(), number: parseInt(match[2], 10) };
}

export async function fetchTicket(
  ticketId: string,
): Promise<LinearTicket | null> {
  const { team, number } = parseTicketInput(ticketId);

  const data = await linearGql(`{
    issues(filter: { number: { eq: ${number} }, team: { key: { eq: "${team}" } } }) {
      nodes {
        title
        description
        url
        identifier
        branchName
      }
    }
  }`);

  const nodes = data?.issues?.nodes;
  if (!nodes || nodes.length === 0) return null;

  const node = nodes[0];
  return {
    identifier: node.identifier,
    title: node.title,
    description: node.description || undefined,
    url: node.url || undefined,
    branchName: node.branchName || undefined,
  };
}

export async function createTicket(
  title: string,
  description: string,
  opts?: { parentId?: string },
): Promise<LinearTicket> {
  const teamId = getLinearTeamId();
  if (!teamId) {
    throw new Error(
      "Linear team ID not configured. Save it to ~/.config/agentdock/linear-team-id"
    );
  }

  // Escape for GraphQL string
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  const extraFields = opts?.parentId ? `parentId: "${opts.parentId}",` : "";

  const data = await linearGql(`mutation {
    issueCreate(input: {
      teamId: "${teamId}",
      ${extraFields}
      title: "${esc(title)}",
      description: "${esc(description)}"
    }) {
      success
      issue {
        identifier
        title
        description
        url
        branchName
      }
    }
  }`);

  if (!data.issueCreate?.success) {
    throw new Error("Failed to create Linear ticket");
  }

  const node = data.issueCreate.issue;
  return {
    identifier: node.identifier,
    title: node.title,
    description: node.description || undefined,
    url: node.url || undefined,
    branchName: node.branchName || undefined,
  };
}

export async function createSubIssue(
  parentTicketId: string,
  title: string,
  description: string,
): Promise<LinearTicket> {
  const parentId = await getIssueId(parentTicketId);
  return createTicket(title, description, { parentId });
}

export async function addComment(
  ticketId: string,
  body: string,
): Promise<void> {
  const issueId = await getIssueId(ticketId);
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  const data = await linearGql(`mutation {
    commentCreate(input: {
      issueId: "${issueId}",
      body: "${esc(body)}"
    }) {
      success
    }
  }`);

  if (!data.commentCreate?.success) {
    throw new Error("Failed to add comment to Linear ticket");
  }
}

export async function updateTicket(
  ticketId: string,
  updates: { description?: string; stateId?: string; title?: string },
): Promise<void> {
  const issueId = await getIssueId(ticketId);
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  const fields: string[] = [];
  if (updates.description !== undefined) fields.push(`description: "${esc(updates.description)}"`);
  if (updates.stateId !== undefined) fields.push(`stateId: "${updates.stateId}"`);
  if (updates.title !== undefined) fields.push(`title: "${esc(updates.title)}"`);

  if (fields.length === 0) return;

  const data = await linearGql(`mutation {
    issueUpdate(id: "${issueId}", input: {
      ${fields.join(", ")}
    }) {
      success
    }
  }`);

  if (!data.issueUpdate?.success) {
    throw new Error("Failed to update Linear ticket");
  }
}

async function getIssueId(ticketId: string): Promise<string> {
  const { team, number } = parseTicketInput(ticketId);
  const data = await linearGql(`{
    issues(filter: { number: { eq: ${number} }, team: { key: { eq: "${team}" } } }) {
      nodes { id }
    }
  }`);
  const nodes = data?.issues?.nodes;
  if (!nodes || nodes.length === 0) throw new Error(`Ticket '${ticketId}' not found`);
  return nodes[0].id;
}

export function buildTicketPrompt(ticket: LinearTicket): string {
  let prompt = `Linear ticket: ${ticket.identifier}`;
  prompt += `\nTitle: ${ticket.title}`;
  if (ticket.url) prompt += `\nURL: ${ticket.url}`;
  if (ticket.description) prompt += `\n\nDescription:\n${ticket.description}`;
  prompt += `\n
## Instructions

Follow these steps IN ORDER. Do not skip ahead to implementation.

**IMPORTANT: You are working in a git worktree.** All code changes MUST be made in your current working directory (check with \`pwd\`). Do NOT \`cd\` to other directories or the main repo. The worktree is already on a dedicated branch for this ticket.

### Step 1: Understand the ticket
Read the ticket carefully. Identify:
- What behavior needs to change?
- Is this about a hardcoded value, a missing feature, or a bug?

### Step 2: Find the relevant code
Search the codebase in your current directory for keywords from the ticket (error messages, field names, feature names).
Find the exact file(s) and function(s) that need to change.

### Step 3: Study existing patterns BEFORE implementing
This is the most important step. Before writing any code:
- Read the surrounding code in the same file and package
- Look for existing config/settings that control this behavior (e.g. app-level configs, feature flags, admin settings). If a hardcoded value exists alongside a configurable one, USE the configurable one — don't just bump the hardcoded number
- Check how similar features/fixes were implemented nearby. Follow the same patterns
- If there are validation limits, check if they come from config or are hardcoded. Prefer config-driven limits

### Step 4: Study existing tests BEFORE writing new ones
- Find existing test files in the same package (\`*_test.go\`, \`test_*.py\`, \`*.test.ts\`)
- Read 2-3 existing tests to understand the testing patterns used:
  - What test framework/helpers are used? (e.g. \`controllertesting.NewTestCase\`, \`pytest\`, etc.)
  - Are tests table-driven (Go) or parameterized?
  - What setup/teardown patterns are used?
- You MUST match the existing test conventions exactly. Do NOT use raw stdlib patterns if the project has custom test helpers

### Step 5: Implement the fix
Now implement. Keep changes minimal and focused:
- Only change what the ticket requires
- Follow the patterns you discovered in steps 3-4
- For Go: use table-driven tests with a single test function containing test cases
- For Python: follow existing test class/method patterns

### Step 6: Verify tests
- Run existing tests in the affected package to make sure nothing breaks
- If tests require a full environment (database, external services) and cannot run locally, note this in the PR description

### Step 7: Create a PR
- Create a PR from your current branch (check with \`git branch --show-current\`) with ticket ID \`${ticket.identifier}\` in the title
- PR description should explain what was changed and why. Do NOT include a test plan section

### Step 8: Monitor CI
After the PR is created, monitor CI status:
- Run \`gh pr checks <pr-number> --watch\` to track CI
- If a check fails and it's related to your changes, investigate the logs, fix the issue, and push
- If a check fails but is unrelated (flaky test, infra issue), restart it with \`gh api repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs -X POST\` — max 5 retries per flaky job, then give up and note it in the PR
- Keep monitoring until all checks pass or you've addressed all failures`;
  return prompt;
}
