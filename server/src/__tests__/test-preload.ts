/**
 * Preload script for bun test.
 * Sets AGENTDOCK_CONFIG_DIR to a temp directory so config.ts uses isolated paths.
 * This env var is read at module evaluation time in config.ts.
 */
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

const TEST_CONFIG_DIR = join(tmpdir(), `agentdock-test-${process.pid}`, ".config", "agentdock");
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
process.env.AGENTDOCK_CONFIG_DIR = TEST_CONFIG_DIR;
// Also override HOME for any code that reads it directly
process.env.HOME = join(tmpdir(), `agentdock-test-${process.pid}`);
