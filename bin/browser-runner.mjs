#!/usr/bin/env node
import { runPilot } from "../src/browser/pilot.mjs";
runPilot(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
