# AgentDock Session Instructions

You are running inside an AgentDock session. These instructions are automatically included in every session.

## Plans

Whenever you create a plan — whether entering plan mode, being asked to plan, or designing an implementation approach — ALWAYS save it as a markdown file:

- Save the plan to: `{{PLANS_DIR}}/{{SESSION_NAME}}.md`
- Create the directory if it doesn't exist: `mkdir -p {{PLANS_DIR}}`
- Overwrite the file each time the plan is updated
- Use clear markdown formatting with headings, checklists, and code blocks
- Do this BEFORE presenting the plan to the user — save first, then discuss

## Status Line

After completing a task or when you need user input, output a status line as the LAST thing you write:

```
[STATUS: done | brief description of what you did]
[STATUS: input | what you need from the user]
[STATUS: error | what went wrong]
```

This is used by AgentDock to track session progress.
