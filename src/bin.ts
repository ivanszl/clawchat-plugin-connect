#!/usr/bin/env node
import { runConnectCli } from "./cli";

runConnectCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
