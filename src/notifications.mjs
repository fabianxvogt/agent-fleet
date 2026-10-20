import { snapshotHealth } from "./collector.mjs";

const MAX_REQUESTS = 1024;
const REQUEST_KINDS = new Set(["question", "approval"]);
const SESSION_KINDS = new Set(["session", "subagent", "worker"]);
const id = (value, max) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max &&
  value.isWellFormed() && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Date.parse normalizes impossible calendar dates instead of rejecting them.
  if (iso.slice(0, 19) !== value.slice(0, 19)) return null;
  return { ms, iso };
}

/**
 * A metadata-only notification observation from one captured collector snapshot.
 * Source failures are independent; absence from an unhealthy source is unknown.
 */
export function attentionFeed(snapshot, { instanceId, now = Date.now() }) {
  let health;
  try { health = snapshotHealth(snapshot, { now }); }
  catch { health = snapshotHealth(null, { now }); }
  const validInterval = snapshot?.intervalMs == null || Number.isFinite(snapshot.intervalMs) && snapshot.intervalMs > 0 && snapshot.intervalMs <= 300_000;
  const staleAfterMs = validInterval && Number.isFinite(health.staleAfterMs) ? health.staleAfterMs : 12_000;
  const fresh = (stamp) => stamp !== null && stamp.ms <= now && now - stamp.ms <= staleAfterMs;
  const generated = timestamp(snapshot?.generatedAt);
  const processObserved = timestamp(snapshot?.processObservedAt);
  const snapshotCurrent = Boolean(snapshot && validInterval && health.ready && fresh(generated));
  const processCurrent = snapshotCurrent && fresh(processObserved) && processObserved.ms <= generated.ms &&
    !snapshot.processError && !health.collectionError;
  const sourceMap = new Map();
  for (const adapter of Array.isArray(health.adapters) ? health.adapters : []) {
    if (!id(adapter?.id, 128)) continue;
    const observed = timestamp(adapter.observedAt);
    const source = { id: adapter.id, observedAt: observed?.iso ?? null,
      current: snapshotCurrent && fresh(observed) && observed.ms <= generated.ms && !adapter.stale && !adapter.error && !adapter.retained };
    // Duplicate identities cannot prove which source supplied a request.
    if (sourceMap.has(source.id)) source.current = false;
    sourceMap.set(source.id, source);
  }
  const sources = [...sourceMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const requests = new Map();
  let truncated = false;
  if (processCurrent) for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
    const source = sourceMap.get(node?.meta?.dataSource);
    const attention = node?.attention;
    if (!source?.current || !id(node?.id, 512) || !SESSION_KINDS.has(node.kind) || node.status !== "waiting" ||
      node.meta?.dataStale || node.meta?.placeholder || !REQUEST_KINDS.has(attention?.kind) || attention.evidence !== "explicit") continue;
    if (attention.requestsComplete === false) { truncated = true; break; }
    // Only a current reducer's complete set establishes pending identities.
    if (attention.requestsComplete !== true || !Array.isArray(attention.requests)) continue;
    if (attention.requests.length > MAX_REQUESTS) { truncated = true; break; }
    for (const pending of attention.requests) {
      const at = timestamp(pending?.at);
      if (!REQUEST_KINDS.has(pending?.kind) || typeof pending.requestId !== "string" || !/^[a-f0-9]{64}$/.test(pending.requestId) ||
        !at || at.ms > now) continue;
      const request = { sessionId: node.id, requestId: pending.requestId, sourceId: source.id, kind: pending.kind, at: at.iso };
      requests.set(JSON.stringify([source.id, node.id, pending.requestId]), request);
      if (requests.size > MAX_REQUESTS) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return {
    version: 1, instanceId, observedAt: new Date(now).toISOString(), staleAfterMs,
    process: { observedAt: processObserved?.iso ?? null, current: processCurrent },
    sources,
    requests: truncated ? [] : [...requests.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) ||
      a.sessionId.localeCompare(b.sessionId) || a.requestId.localeCompare(b.requestId)),
    truncated,
  };
}
