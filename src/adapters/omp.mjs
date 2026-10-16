import { join } from "node:path";
import { projectName } from "../util.mjs";
import { createSessionTreeAdapter } from "./session-tree.mjs";

/** oh-my-pi: ~/.omp/agent/sessions. Depth maps onto the L0/L1/L2 hierarchy launched via l1_session. */
export const createOmpAdapter = () =>
  createSessionTreeAdapter({
    id: "omp",
    label: "OhMyPi",
    agent: "omp",
    sessionsDir: (home) => join(home, ".omp", "agent", "sessions"),
    roleForDepth: (depth) => `L${depth}`,
    titleFallback: (i) => `omp · ${projectName(i.cwd)}`,
  });
