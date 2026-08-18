import type { GraphEdge, WorkflowLoop } from '../graph';
import type { StepKey } from './execution.types';

/**
 * Which iterations an edge connects (design: CAT-2875, L1). Every edge maps the
 * row it leaves to the row it feeds:
 *
 * - `plain`: neither end is in a loop, so both rows sit at iteration 0.
 * - `entry`: feeds a batch node from outside. Only iteration 0 is fed this way,
 *   since later passes are fed by the return edge instead.
 * - `intra`: both ends inside one loop, so both rows sit at the same pass.
 * - `back`: the marked return edge, where pass `i` feeds pass `i + 1`.
 * - `exit`: leaves a loop from the batch node's done slot. It reads the loop's
 *   terminal row, whatever iteration that turns out to be, and feeds a row back
 *   at iteration 0.
 *
 * An edge leaving one loop straight into another is `exit`: that is what decides
 * which row it reads, and both classes agree the row it feeds sits at iteration 0.
 */
export type EdgeClass = 'plain' | 'entry' | 'intra' | 'back' | 'exit';

/**
 * What an edge reads at a given iteration. The two negative cases mean different
 * things and must not be collapsed:
 *
 * - `none`: the edge connects nothing at this iteration, so the caller ignores
 *   it. An entry edge feeds iteration 0 only, a return edge feeds 1 upwards.
 *   Treating this as unresolved would leave every later pass undecidable.
 * - `pending`: the edge reads a terminal row that does not exist yet, so the
 *   caller leaves the decision undecidable (L2). Treating this as `none` would
 *   decide the done side of a loop that has not ended, and fates are immutable.
 */
export type SourceRow = { kind: 'row'; key: StepKey } | { kind: 'none' } | { kind: 'pending' };

export function classifyEdge(edge: GraphEdge, loops: WorkflowLoop[]): EdgeClass {
	if (edge.isBackEdge) return 'back';

	const sourceLoop = loops.find((loop) => loop.memberIds.has(edge.from));
	const targetLoop = loops.find((loop) => loop.memberIds.has(edge.to));

	if (sourceLoop && sourceLoop === targetLoop) return 'intra';
	if (sourceLoop) return 'exit';
	if (targetLoop) return 'entry';
	return 'plain';
}

/** The row an edge feeds, given the row it leaves. */
export function targetKey(edge: GraphEdge, edgeClass: EdgeClass, source: StepKey): StepKey {
	switch (edgeClass) {
		case 'back':
			return { nodeId: edge.to, iteration: source.iteration + 1 };
		case 'exit':
		case 'entry':
			return { nodeId: edge.to, iteration: 0 };
		default:
			return { nodeId: edge.to, iteration: source.iteration };
	}
}

/** The row an edge reads, given the row it feeds. */
export function sourceRow(
	edge: GraphEdge,
	edgeClass: EdgeClass,
	target: StepKey,
	terminalIteration?: number,
): SourceRow {
	const row = (iteration: number): SourceRow => ({
		kind: 'row',
		key: { nodeId: edge.from, iteration },
	});

	switch (edgeClass) {
		case 'back':
			return target.iteration === 0 ? { kind: 'none' } : row(target.iteration - 1);
		case 'entry':
			return target.iteration > 0 ? { kind: 'none' } : row(0);
		case 'exit':
			if (target.iteration > 0) return { kind: 'none' };
			return terminalIteration === undefined ? { kind: 'pending' } : row(terminalIteration);
		default:
			return row(target.iteration);
	}
}
