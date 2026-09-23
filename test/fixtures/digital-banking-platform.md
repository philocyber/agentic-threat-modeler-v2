# Digital Banking Platform Security Assessment

An Internet-facing React SPA sends customer authentication and banking requests over HTTPS to a Kong API Gateway. Kong validates signed JWTs and enforces per-user and per-IP rate limits before forwarding authenticated REST calls to a Node.js backend in a private Kubernetes cluster.

The backend stores customer PII, balances, beneficiaries, and transaction history in PostgreSQL 15 using parameterized queries. Redis stores short-lived session metadata, is reachable only from the private cluster, uses ACLs, and does not store raw authentication tokens. PostgreSQL and Redis are not Internet-facing.

Payments are submitted by the backend to an external payment provider over HTTPS using signed requests with replay-resistant timestamps. Administrative operations require RBAC. Audit events for authentication, beneficiary changes, and payments are sent to a SIEM.

The assessment should identify residual and conditional threats without claiming that documented controls are absent. It should cover authentication, authorization, transaction integrity, business logic, availability, supply chain, secrets, logging, payment integration, database, cache, Kubernetes, and browser-facing risks.
