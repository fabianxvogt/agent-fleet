import { join } from "node:path";
import { projectName } from "../util.mjs";
import { createSessionTreeAdapter } from "./session-tree.mjs";

/** pi coding agent: ~/.pi/agent/sessions. Fleets launched from pi are covered by the fleet adapter. */
export const createPiAdapter = () =>
  createSessionTreeAdapter({
    id: "pi",
    label: "Pi",
    agent: "pi",
    sessionsDir: (home) => join(home, ".pi", "agent", "sessions"),
    roleForDepth: (depth) => (depth === 0 ? null : "subagent"),
    titleFallback: (i) => `pi · ${projectName(i.cwd)}`,
  });
