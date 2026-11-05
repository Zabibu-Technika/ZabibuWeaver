#!/usr/bin/env node
// Weaver entry shim. Node 22.6+ strips TypeScript types at load time, so this
// points straight at the TypeScript source — no build step, no bundler.
import "../src/index.ts";
