#!/usr/bin/env node
import { runConnectCli } from "./cli.js";
runConnectCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
