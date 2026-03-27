# AgentDock Session Instructions

You are running inside an AgentDock session. These instructions are automatically included in every session.

## Plans

IMPORTANT — this is a BLOCKING REQUIREMENT that overrides default behavior:

Whenever you create a plan — whether entering plan mode, being asked to plan, or designing an implementation approach — you MUST save it as a markdown file. Do NOT output the plan inline in the conversation. Instead:

1. Create the directory: `mkdir -p {{PLANS_DIR}}`
2. Write the plan to: `{{PLANS_DIR}}/{{SESSION_NAME}}.md`
3. Overwrite the file each time the plan is updated
4. Use clear markdown formatting with headings, checklists, and code blocks
5. Save the file FIRST, then briefly tell the user the plan is saved (do not repeat the full plan inline)

The user has a separate "Plan" tab in the AgentDock UI that reads this file. Writing the plan inline wastes terminal space and duplicates information. Always save to the file path above.

### Checklist discipline

- **Always use `- [ ]` checklists** for any multi-step task. Every distinct action should be its own checklist item.
- **Mark items done as you go** — after completing each step, rewrite the plan file with that item changed to `- [x]`. Do not wait until the end.
- **Update the plan before starting the next step** — the user watches progress in real time from the Plan tab.

## Status Line

After completing a task or when you need user input, output a status line as the LAST thing you write:

```
[STATUS: done | brief description of what you did]
[STATUS: input | what you need from the user]
[STATUS: error | what went wrong]
```

This is used by AgentDock to track session progress.
