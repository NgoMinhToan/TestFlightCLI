#!/usr/bin/env node
import { runCli } from "./run.js";

// A closed pipe (for example `testflight --help | head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

process.exitCode = await runCli(process.argv.slice(2));
