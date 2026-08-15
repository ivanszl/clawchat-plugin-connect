#!/usr/bin/env bun
import { runConnectCli } from "./service/cli";

const run = runConnectCli(process.argv.slice(2));

run.then((code) => {
  process.exitCode = code;
});
