import { edge } from "../model.mjs";
import { selectSessionBranch } from "../session-branch.mjs";
import { isoOrNull } from "../util.mjs";

const MAX_RECORDS = 512;
const MAX_ITEMS = 64;
const MAX_OBSERVATIONS = 128;
const RESULT_SUFFIX = ".l1-result.txt";
const terminal = new Set(["completed", "failed", "cancelled"]);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value : null;
const sourcePath = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value) ? value : null;
const advisor = (value) => /(?:^|\.)__advisor(?:$|[._-])/i.test(value ?? "");

/** Recognize supported OMP envelopes, never message prose or result files.
 * These small internal observations contain identity/time only, not bodies. */
export function readRelationObservations(input) {
  const calls = new Map();
  const observations = [];
  const add = (observation) => {
    observations.push(observation);
    if (observations.length > MAX_OBSERVATIONS) observations.shift();
  };
  for (const record of selectSessionBranch(input.slice(-MAX_RECORDS), "omp").records) {
    const at = isoOrNull(record.timestamp);
    const message = record.type === "message" ? object(record.message) : null;
    if (message?.role === "assistant") {
      for (const part of (Array.isArray(message.content) ? message.content : []).slice(0, MAX_ITEMS)) {
        if (part?.type !== "toolCall" || part.name !== "l1_session" || !identity(part.id)) continue;
        const args = object(part.arguments);
        if (args && identity(args.op)) {
          calls.set(part.id, calls.has(part.id) ? null : { action: args.op });
          if (calls.size > MAX_OBSERVATIONS) calls.delete(calls.keys().next().value);
        }
      }
    }
    if (message?.role === "toolResult" && identity(message.toolCallId)) {
      const call = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (!call || message.isError !== false || message.toolName && message.toolName !== "l1_session") continue;
      const details = message.details;
      const value = object(details);
      const eventId = `tool:${message.toolCallId}`;
      if (["start", "launch", "list", "status"].includes(call.action)) {
        const workers = call.action === "list" && Array.isArray(details) ? details : value?.workers;
        for (const worker of (Array.isArray(workers) ? workers : []).slice(0, MAX_ITEMS)) {
          if (!object(worker) || !identity(worker.id) || worker.error) continue;
          add({ kind: "binding", eventId, at, workerId: worker.id,
            sessionFile: sourcePath(worker.sessionFile), outputFile: sourcePath(worker.outputFile),
            spawn: ["start", "launch"].includes(call.action),
            ...(call.action === "status" ? { hostFile: sourcePath(value?.host?.sessionFile), hostId: identity(value?.host?.sessionId) } : {}) });
        }
      } else if (call.action === "send" && value && identity(value.id) && identity(value.sent)) {
        add({ kind: "message", direction: "out", eventId, at, workerId: value.id, label: "Message queued" });
      } else if (["results", "close"].includes(call.action) && value) {
        const results = [...(Array.isArray(value.results) ? value.results.slice(0, MAX_ITEMS) : []),
          ...(call.action === "close" && object(value.result) ? [value.result] : [])];
        const seen = new Set();
        for (const result of results) {
          if (!object(result) || !identity(result.id) || typeof result.ok !== "boolean" || seen.has(result.id)) continue;
          seen.add(result.id);
          add({ kind: "report", direction: "in", eventId, at, workerId: result.id,
            outputFile: sourcePath(result.outputFile), label: "Result received" });
        }
      }
    }
    const custom = record.type === "custom_message" ? record : message?.role === "custom" ? message : null;
    const details = object(custom?.details);
    if (custom?.customType === "irc:incoming" && details && identity(details.id) && identity(details.from)) {
      add({ kind: details.wakeRelay === true ? "report" : "message", direction: "in",
        eventId: `irc:${details.id}`, at, workerId: details.from,
        label: details.wakeRelay === true ? "Result received" : "Message received" });
    } else if (custom?.customType === "async-result" && details) {
      for (const job of (Array.isArray(details.jobs) ? details.jobs : []).slice(0, MAX_ITEMS)) {
        if (!object(job) || job.type !== "task" || !identity(job.agentId) || !terminal.has(job.status)) continue;
        const jobId = identity(job.jobId);
        if (jobId) add({ kind: "report", direction: "in", eventId: `async:${jobId}`,
          at, workerId: job.agentId, label: "Result received" });
      }
    }
  }
  return observations;
}

function uniqueIndex(items, key) {
  const index = new Map();
  for (const item of items) {
    const value = key(item);
    if (value) index.set(value, index.has(value) ? null : item);
  }
  return index;
}

/** Resolve only identities from the currently observed files. Nothing returned
 * here can cause the generic linker to invent a communication endpoint. */
export function resolveSessionRelations(input, { now, windowMs }) {
  const ids = uniqueIndex(input, (s) => s.id);
  const paths = uniqueIndex(input, (s) => s.source);
  const sessions = input.filter((s) => ids.get(s.id) === s && paths.get(s.source) === s);
  const timed = (observation) => {
    const at = Date.parse(observation.at);
    return Number.isFinite(at) && at >= now - windowMs && at <= now;
  };
  const observations = sessions.flatMap((owner) => (owner.observations ?? [])
    .filter(timed).map((observation) => ({ ...observation, owner })));
  const sourceFor = (observation) => {
    const outputSource = observation.outputFile?.endsWith(RESULT_SUFFIX) ? observation.outputFile.slice(0, -RESULT_SUFFIX.length) : null;
    if (observation.outputFile && observation.sessionFile && outputSource !== observation.sessionFile) return null;
    const path = observation.sessionFile ?? outputSource;
    return path ? paths.get(path) : null;
  };
  const bindings = observations.filter((o) => o.kind === "binding" && !advisor(o.workerId)
    && (!Object.hasOwn(o, "hostFile") || o.hostFile === o.owner.source && `omp:${o.hostId}` === o.owner.id))
    .map((o) => ({ ...o, child: sourceFor(o) }))
    .filter((o) => o.child && ids.get(o.child.id) === o.child && o.child.id !== o.owner.id
      && o.child.nativeRoot === o.child.source);
  const declaredOwners = new Map();
  for (const binding of bindings) {
    const owners = declaredOwners.get(binding.child.id) ?? new Set();
    owners.add(binding.owner.id);
    declaredOwners.set(binding.child.id, owners);
  }
  const scopeParents = new Map();
  for (const session of sessions) {
    const owners = declaredOwners.get(session.id);
    if (owners?.size === 1) scopeParents.set(session.id, [...owners][0]);
    else if (owners?.size > 1) scopeParents.set(session.id, null);
    else if (session.nativeRoot && session.nativeRoot !== session.source) {
      const parent = paths.get(session.parentSource);
      scopeParents.set(session.id, parent && (parent.source === session.nativeRoot || parent.nativeRoot === session.nativeRoot) ? parent.id : null);
    }
  }
  const roots = new Map();
  const rootOf = (id) => {
    if (roots.has(id)) return roots.get(id);
    const chain = new Set();
    let current = id;
    while (current && !roots.has(current) && scopeParents.has(current) && !chain.has(current)) {
      chain.add(current);
      current = scopeParents.get(current);
    }
    const root = roots.has(current) ? roots.get(current) : current && !chain.has(current) && ids.get(current) ? current : null;
    for (const member of chain) roots.set(member, root);
    roots.set(id, root);
    return root;
  };
  const aliases = new Map();
  const alias = (root, name, target) => {
    if (!root || !identity(name) || advisor(name)) return;
    const key = `${root}\0${name}`;
    const existing = aliases.get(key);
    aliases.set(key, existing === undefined || existing === target ? target : null);
  };
  const nativeParents = new Map();
  for (const session of sessions) {
    const root = rootOf(session.id);
    if (root === session.id) alias(root, "Main", session.id);
    if (!session.nativeName || advisor(session.nativeName)) continue;
    const parent = paths.get(session.parentSource);
    if (!parent || parent.id === session.id || rootOf(parent.id) !== root || !root) continue;
    alias(root, session.nativeName, session.id);
    nativeParents.set(session.id, parent.id);
  }
  const managed = new Map();
  const ownership = new Map();
  for (const binding of bindings) {
    const root = rootOf(binding.owner.id);
    if (!root || declaredOwners.get(binding.child.id)?.size !== 1 || rootOf(binding.child.id) !== root) continue;
    alias(root, binding.workerId, binding.child.id);
    ownership.set(binding.child.id, binding.owner.id);
    if (binding.spawn) managed.set(binding.child.id, { parentId: binding.owner.id, at: binding.at });
  }
  const grouped = new Map();
  for (const observation of observations) {
    if (observation.kind === "binding" || advisor(observation.workerId)) continue;
    const owner = observation.owner;
    const root = rootOf(owner.id);
    let target = root ? aliases.get(`${root}\0${observation.workerId}`) : null;
    // A launcher result's own explicit output path identifies an already known
    // child even when the start receipt has fallen outside the bounded tail.
    if (observation.kind === "report" && observation.outputFile) {
      const fileTarget = sourceFor(observation);
      if (!fileTarget || ids.get(fileTarget.id) !== fileTarget || advisor(fileTarget.nativeName)
        || target && target !== fileTarget.id
        || (fileTarget.nativeRoot !== fileTarget.source || declaredOwners.has(fileTarget.id)) && rootOf(fileTarget.id) !== root) continue;
      target = fileTarget.id;
    }
    if (!target || target === owner.id || !ids.get(target)) continue;
    const from = observation.direction === "in" ? target : owner.id;
    const to = observation.direction === "in" ? owner.id : target;
    const value = edge(from, to, observation.kind, { at: observation.at, label: observation.label });
    let group = grouped.get(value.id);
    if (!group) { group = { value, events: new Set() }; grouped.set(value.id, group); }
    group.events.add(observation.eventId);
    if (observation.at > group.value.at) {
      group.value.at = observation.at;
      group.value.label = observation.label;
    }
    group.value.count = group.events.size;
  }
  return {
    edges: [...managed].map(([child, value]) => edge(value.parentId, child, "spawn", { at: value.at, label: "Started worker" }))
      .concat([...grouped.values()].map((group) => group.value)),
    managed, ownership, nativeParents,
  };
}
