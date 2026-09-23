# Document 1: workflow
The LedgerBridge service accepts a tenant export job and sends it to ExportWorker.
Cross-reference: the production permission rule is specified in Document 6.
A user may request only their own tenant's export. The identity must survive queue delivery.
