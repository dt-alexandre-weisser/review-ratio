/**
 * A cheap structural guard run before schema validation.
 *
 * Schema validation builds one error per offending key or item, so a body stuffed with tens of
 * thousands of unknown keys would cost a second of CPU to reject. This walk rejects such bodies in
 * linear time without allocating errors. The bounds are loose on purpose: well above any valid
 * payload of any major, far below anything expensive.
 */
export interface ShapeLimits {
  /** Keys per object. Contract major 1 needs at most 8. */
  maxKeys: number;
  /** Items per array. Contract major 1 allows at most 500. */
  maxItems: number;
  /** Nesting depth. Contract major 1 needs 4. */
  maxDepth: number;
}

export const SHAPE_LIMITS: Readonly<ShapeLimits> = Object.freeze({
  maxKeys: 32,
  maxItems: 1_000,
  maxDepth: 8,
});

/** Why the value is too large to validate, or `null` when it is within the limits. */
export function shapeProblem(value: unknown, limits: ShapeLimits = SHAPE_LIMITS): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { node, depth } = entry;
    if (typeof node !== 'object' || node === null) continue;
    if (depth > limits.maxDepth) return `nested deeper than ${limits.maxDepth} levels`;
    if (Array.isArray(node)) {
      if (node.length > limits.maxItems) return `an array has more than ${limits.maxItems} items`;
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else {
      const values = Object.values(node);
      if (values.length > limits.maxKeys) return `an object has more than ${limits.maxKeys} keys`;
      for (const item of values) stack.push({ node: item, depth: depth + 1 });
    }
  }
  return null;
}
