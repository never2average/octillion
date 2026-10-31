#!/usr/bin/env node
// The octillion command (packages/cli). Plain ESM, no dependencies, Node 20 or later.
import { main } from "../src/cli.js";

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`octillion: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
