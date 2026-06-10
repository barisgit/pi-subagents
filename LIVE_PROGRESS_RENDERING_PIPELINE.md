# Live progress rendering pipeline

Live progress flows from child agent events into `Details.progress`, then through `renderSubagentResult()` for foreground display and `status-writer.ts` for async status. Single runs render one compact card; parallel and workflow runs render per-agent rows with aggregate usage and duration.
