#!/usr/bin/env node
// The entry point of the `config:*` tasks of mise.toml (settings-store STORE-TASK-001): `node packages/store/dist/cli/index.js
// <command> [arguments]`.
import { processIo } from "./io.js";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), processIo());
