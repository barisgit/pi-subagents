Agent color now persists post-completion in multi-block rows: `rowColor` falls
back from `r.progress?.color` to a `color` field on `progressFromArray`, so
even after the live progress entry transitions out of "running", the tint is
retained and `tintAgentName` keeps the name colored on completed rows.
