export interface PreviewChangeSet {
  clean: boolean;
  diff: string;
  files: Array<{
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

export function previewChangeFingerprint(changes: PreviewChangeSet): string {
  if (changes.clean && changes.files.length === 0) return "clean";
  const files = changes.files
    .map((file) => [file.status, file.previousPath ?? "", file.path, file.additions, file.deletions].join(":"))
    .join("|");
  return `${files}\n${changes.diff}`;
}

export function shouldRefreshPreview(previousFingerprint: string | null, nextFingerprint: string): boolean {
  return previousFingerprint !== null && previousFingerprint !== nextFingerprint;
}
