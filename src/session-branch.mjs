/**
 * Select known ancestors from a bounded Pi-format transcript tail.
 * OMP late usage can name the active leaf instead of selecting its own branch.
 * An absent selected leaf cannot be recovered from a partial tail: stay empty.
 */
export function selectSessionBranch(records, agent) {
  if (!["pi", "omp", "fleet"].includes(agent) || !records.some(r => Object.hasOwn(r, "parentId"))) {
    return { records, branch: null };
  }
  const byId = new Map(records.filter(r => typeof r.id === "string").map(r => [r.id, r]));
  const last = records.findLast(r => typeof r.id === "string");
  const selected = agent === "omp" && last?.type === "model_usage" && Object.hasOwn(last, "activeLeafId")
    ? last.activeLeafId : last?.id;
  if (typeof selected !== "string") return { records: [], branch: null };
  const keep = new Set();
  let record = byId.get(selected);
  while (record && !keep.has(record.id)) {
    keep.add(record.id);
    record = byId.get(record.parentId);
  }
  return {
    records: records.filter(r => keep.has(r.id) && byId.get(r.id) === r),
    branch: { head: selected, ancestry: [...keep] },
  };
}
