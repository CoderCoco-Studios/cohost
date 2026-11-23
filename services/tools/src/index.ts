/**
 * tools: the co-host's tool service. Routes the model's tool calls to MCP servers and built-in tools, enforces who may
 * cause a call and whether it needs the owner's confirmation, and publishes each result. Starts with `runTools`.
 */
import { runTools } from "./main.js";

void runTools(); // the shared bootstrap handles failures: it logs and exits 1
