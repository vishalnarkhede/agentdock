# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in agentdock, please report it responsibly.

**Email:** vishalnarkhede.iitd@gmail.com

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

I will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Security Model

agentdock is designed to run locally on your machine:

- **Localhost binding** — the server binds to `localhost` by default and is not exposed to the network
- **No cloud dependencies** — all data is stored in local files (`~/.config/agentdock/`)
- **Optional authentication** — password protection available for network access scenarios
- **Agent isolation** — each agent runs in its own tmux session with configurable tool permissions
- **No telemetry** — agentdock does not collect or transmit any data

## Sensitive Files

The following files may contain secrets and should not be committed to version control:

- `~/.config/agentdock/linear-api-key`
- `~/.config/agentdock/slack-token`
- `~/.config/agentdock/password`

These files are created with `chmod 600` permissions during setup.
