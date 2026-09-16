export type ReviewAction = "accept-all" | "reject-all" | "accept-file" | "reject-file" | "accept-hunk" | "reject-hunk";

export type ReviewHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  additions: number;
  deletions: number;
  lines: string[];
  patch: string;
};

export type ReviewFile = {
  path: string;
  kind: "modified" | "added" | "deleted";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: ReviewHunk[];
};

export type TaskReviewState = {
  taskId: string;
  createdAt: string;
  status: string;
  files: ReviewFile[];
  additions: number;
  deletions: number;
  pendingFiles: number;
  pendingHunks: number;
};

interface ReviewPanelProps {
  review: TaskReviewState | null;
  loading: boolean;
  onRefresh: () => void;
  onAction: (action: ReviewAction, path?: string, hunkId?: string) => void;
}

function lineClass(line: string): string {
  if (line.startsWith("+")) return "reviewLine addition";
  if (line.startsWith("-")) return "reviewLine deletion";
  if (line.startsWith("\\ No newline")) return "reviewLine meta";
  return "reviewLine context";
}

export default function ReviewPanel({ review, loading, onRefresh, onAction }: ReviewPanelProps) {
  if (!review) {
    return <div className="reviewEmpty"><p>Run a BORG task to create a task-relative review baseline.</p><button onClick={onRefresh}>Refresh</button></div>;
  }

  const clean = review.files.length === 0;

  return <div className="reviewPanel">
    <div className="reviewSummary">
      <div>
        <strong>{clean ? "No pending BORG changes" : `${review.pendingFiles} file${review.pendingFiles === 1 ? "" : "s"} · ${review.pendingHunks} hunk${review.pendingHunks === 1 ? "" : "s"}`}</strong>
        <span><b className="plus">+{review.additions}</b> <b className="minus">−{review.deletions}</b> · Review is relative to the state before this task.</span>
      </div>
      <div className="reviewGlobalActions">
        <button onClick={onRefresh} disabled={loading}>Refresh</button>
        <button onClick={() => onAction("reject-all")} disabled={loading || clean} className="dangerGhost">Reject all</button>
        <button onClick={() => onAction("accept-all")} disabled={loading || clean} className="primaryGhost">Accept all</button>
      </div>
    </div>

    {clean && <div className="reviewClean">
      <div className="reviewCleanMark">✓</div>
      <strong>Review complete</strong>
      <p>Accepted changes remain in your working tree. Rejected changes were restored to the task baseline. Nothing was staged or committed.</p>
    </div>}

    {!clean && <div className="reviewFiles">
      {review.files.map((file) => <details className="reviewFile" key={file.path} open>
        <summary>
          <div className="reviewFileIdentity">
            <span className={`fileKind ${file.kind}`}>{file.kind === "modified" ? "M" : file.kind === "added" ? "A" : "D"}</span>
            <code title={file.path}>{file.path}</code>
          </div>
          <div className="reviewFileMeta">
            <span className="plus">+{file.additions}</span>
            <span className="minus">−{file.deletions}</span>
            <span>{file.binary ? "binary" : `${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`}</span>
          </div>
        </summary>

        <div className="reviewFileActions">
          <span>File decision</span>
          <div>
            <button className="dangerGhost" disabled={loading} onClick={() => onAction("reject-file", file.path)}>Reject file</button>
            <button className="primaryGhost" disabled={loading} onClick={() => onAction("accept-file", file.path)}>Accept file</button>
          </div>
        </div>

        {file.binary && <div className="binaryNotice">Binary changes are reviewed at file level only.</div>}

        {!file.binary && file.hunks.map((hunk) => <section className="reviewHunk" key={hunk.id}>
          <div className="reviewHunkHeader">
            <code>{hunk.header}</code>
            <div>
              <button className="dangerGhost" disabled={loading} onClick={() => onAction("reject-hunk", file.path, hunk.id)}>Reject</button>
              <button className="primaryGhost" disabled={loading} onClick={() => onAction("accept-hunk", file.path, hunk.id)}>Accept</button>
            </div>
          </div>
          <pre className="reviewCode">{hunk.lines.map((line, index) => <span className={lineClass(line)} key={`${hunk.id}-${index}`}>{line || " "}</span>)}</pre>
        </section>)}
      </details>)}
    </div>}
  </div>;
}
