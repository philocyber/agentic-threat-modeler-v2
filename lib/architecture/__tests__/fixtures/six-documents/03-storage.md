# Document 3: storage
ArchiveStore contains tenant export objects. Object keys include a tenant identifier.
ExportWorker must use the tenant identity from the job, not a default administrator identity.
