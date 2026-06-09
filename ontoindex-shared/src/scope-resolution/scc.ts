export interface StronglyConnectedComponent {
  readonly nodes: readonly string[];
  readonly isCycle: boolean;
}

/**
 * Iterative Tarjan SCC. Returns SCCs in reverse-topological order
 * (leaves first), matching the scope finalizer's processing contract.
 */
export function tarjanSccs(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): StronglyConnectedComponent[] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: StronglyConnectedComponent[] = [];
  let idx = 0;

  const allNodes = Array.from(graph.keys()).sort();
  const iterStack: Array<{ node: string; children: Iterator<string>; entered: boolean }> = [];

  for (const root of allNodes) {
    if (index.has(root)) continue;
    iterStack.push({
      node: root,
      children: (graph.get(root) ?? new Set<string>()).values(),
      entered: false,
    });
    while (iterStack.length > 0) {
      const frame = iterStack[iterStack.length - 1]!;

      if (!frame.entered) {
        frame.entered = true;
        index.set(frame.node, idx);
        lowlink.set(frame.node, idx);
        idx++;
        stack.push(frame.node);
        onStack.add(frame.node);
      }

      const nextChild = frame.children.next();
      if (nextChild.done) {
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          let selfInCycle = false;
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === frame.node) {
              selfInCycle = (graph.get(w) ?? new Set()).has(w);
              break;
            }
          }
          const isCycle = scc.length > 1 || selfInCycle;
          const observableNodes =
            scc.length > 1 ? [...scc.slice(0, -1).reverse(), scc[scc.length - 1]!] : scc;
          sccs.push({ nodes: Object.freeze(observableNodes), isCycle });
        }
        iterStack.pop();
        if (iterStack.length > 0) {
          const parent = iterStack[iterStack.length - 1]!;
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
        }
        continue;
      }

      const child = nextChild.value;
      if (!index.has(child)) {
        iterStack.push({
          node: child,
          children: (graph.get(child) ?? new Set<string>()).values(),
          entered: false,
        });
      } else if (onStack.has(child)) {
        lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(child)!));
      }
    }
  }

  return sccs;
}
