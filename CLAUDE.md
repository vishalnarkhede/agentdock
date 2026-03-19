Read @AGENTS.md

## Testing

After making any code changes, always run the test suite to ensure nothing is broken:

```bash
cd server && bun test
```

- Run tests before committing or creating PRs
- If you add new functionality, add corresponding tests
- Tests live in `server/src/__tests__/`
- Use Bun's built-in test runner
