export interface TopologyCommit {
  sha: string;
  parentShas: readonly string[];
}
export interface CommitTopology {
  nodes: Array<{ sha: string; row: number; lane: number; outsideParents: string[] }>;
  edges: Array<{ from: number; to: number }>;
  lanes: number;
}
/** Edges are only actual Git parent links. A missing parent is a window boundary. */
export function buildCommitTopology(commits: readonly TopologyCommit[]): CommitTopology {
  const frontier: Array<string | null> = [];
  const nodes: CommitTopology["nodes"] = [];
  const rows = new Map(commits.map((commit, row) => [commit.sha, row]));
  const edges: CommitTopology["edges"] = [];
  let lanes = 1;
  for (const [row, commit] of commits.entries()) {
    let lane = frontier.indexOf(commit.sha);
    if (lane < 0) {
      lane = frontier.indexOf(null);
      if (lane < 0) lane = frontier.length;
    }
    frontier[lane] = null;
    nodes.push({
      sha: commit.sha,
      row,
      lane,
      outsideParents: commit.parentShas.filter((sha) => !rows.has(sha)),
    });
    for (const [index, sha] of commit.parentShas.entries()) {
      const to = rows.get(sha);
      if (to !== undefined) edges.push({ from: row, to });
      if (frontier.includes(sha)) continue;
      let parentLane = index === 0 && frontier[lane] === null ? lane : frontier.indexOf(null);
      if (parentLane < 0) parentLane = frontier.length;
      frontier[parentLane] = sha;
    }
    lanes = Math.max(lanes, frontier.length, lane + 1);
  }
  return { nodes, edges, lanes };
}
