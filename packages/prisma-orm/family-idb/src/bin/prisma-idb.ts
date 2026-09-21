#!/usr/bin/env node
import { runIdbCli } from "../cli/cli";

runIdbCli(process)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
