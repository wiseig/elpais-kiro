/** Diff de líneas (LCS) para mostrar cambios en la configuración. */

export type DiffOpType = 'same' | 'add' | 'del';

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // Prefijo y sufijo comunes para achicar la matriz.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: 'same', text: a[i] ?? '' });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    for (const text of midA) ops.push({ type: 'del', text });
    for (const text of midB) ops.push({ type: 'add', text });
  } else if (n > 0 || m > 0) {
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        const idx = i * width + j;
        if (midA[i] === midB[j]) {
          dp[idx] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
        } else {
          dp[idx] = Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'same', text: midA[i] ?? '' });
        i += 1;
        j += 1;
      } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
        ops.push({ type: 'del', text: midA[i] ?? '' });
        i += 1;
      } else {
        ops.push({ type: 'add', text: midB[j] ?? '' });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', text: midA[i] ?? '' });
      i += 1;
    }
    while (j < m) {
      ops.push({ type: 'add', text: midB[j] ?? '' });
      j += 1;
    }
  }

  for (let k = endA; k < a.length; k += 1) ops.push({ type: 'same', text: a[k] ?? '' });
  return ops;
}

export function diffSummary(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}
