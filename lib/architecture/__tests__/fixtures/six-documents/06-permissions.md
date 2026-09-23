# Document 6: current permissions
LedgerBridge uses scoped roles in production; its service identity cannot read another tenant's exports.
This rule qualifies the export workflow in Document 1. Staging still has a shared administrator credential.
JWT validation is enabled on LedgerBridge. A second production note says LedgerBridge JWT validation is disabled.
These conflicting notes need verification; neither claim may silently override the other.
