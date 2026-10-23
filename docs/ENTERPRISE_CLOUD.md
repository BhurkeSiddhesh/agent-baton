# Enterprise and cloud architecture

## Product packaging

Agent Baton can become a commercial product, but the enterprise offering should not be a hosted copy of the current
CLI. It needs a control plane, isolated worker plane, enterprise identity and a supportable release channel.

The recommended product family is:

| Edition | Runs where | Best for | Commercial model |
|---|---|---|---|
| Community | Developer machine or CI | Evaluation, individuals, open source | MIT core |
| Team Cloud | Managed Baton control plane with customer-connected runners | Small teams wanting low operations | Monthly base plus metered execution |
| Enterprise BYOC | Control plane and/or runners in the customer's AWS or Azure account | Regulated source code and private networks | Annual subscription by seats/concurrency plus support |
| Enterprise self-managed | Kubernetes or VM installation in a customer environment | Air-gapped or strict residency requirements | Annual license, updates and support |

The customer should normally bring model subscriptions or API credentials. Baton may later resell inference, but
mixing orchestration fees and model usage initially makes margins, rate limits and data processing harder to explain.

## Deployment topology

```text
Operator UI / API
        │
Identity, policy and approval service
        │
Durable scheduler ─── event store ─── audit/metrics
        │
Queue and capability router
        │
┌───────┴────────────────────────────────────────┐
│ customer worker pool                           │
│ isolated job → checkout/worktree → agent CLI   │
│              → tools/browser → evidence        │
└────────────────────────────────────────────────┘
```

The control plane schedules work and stores minimum necessary metadata. The worker plane holds source checkouts,
model credentials and tool access. Enterprises must be able to keep the worker plane and sensitive artifacts inside
their own network even when using a managed control plane.

## AWS, Azure and portable installation

The reference deployment should target Kubernetes first, with Terraform modules for cloud-specific dependencies:

- AWS: EKS or ECS workers, RDS PostgreSQL, SQS, S3, Secrets Manager, KMS, CloudWatch and PrivateLink/VPC controls.
- Azure: AKS or Container Apps workers, Azure Database for PostgreSQL, Service Bus, Blob Storage, Key Vault, Monitor
  and Private Link/VNet controls.
- Self-managed: Kubernetes with PostgreSQL, an S3-compatible object store, a durable queue and customer-selected
  secret manager; a single-node evaluation profile may use containers but is not the HA production architecture.

Cloud-specific adapters should sit behind portable interfaces for queue, object storage, secrets, identity and worker
provisioning. Do not build separate products for AWS and Azure.

## Enterprise requirements

Before selling an enterprise edition, the platform needs:

- tenant isolation and per-tenant encryption boundaries;
- SSO through OIDC/SAML, SCIM provisioning and role-based access control;
- service identities for orchestrators, workers and integrations;
- customer-managed keys where required;
- secret references so credentials are not exposed to model context or logs;
- outbound network policies and private repository connectivity;
- immutable audit export, retention and legal-hold controls;
- configurable human approval and separation-of-duty policies;
- quotas for concurrency, tokens, time, storage and external tools;
- signed releases, SBOMs, vulnerability handling and upgrade/rollback procedures;
- backup, restore, regional availability, SLOs and disaster-recovery evidence;
- data residency, deletion, subprocessors and a documented shared-responsibility model.

Claims such as SOC 2, ISO 27001, HIPAA support or production isolation require actual controls and independent evidence;
they must not be inferred from architecture documents.

## Subscription and entitlement model

A practical initial pricing unit is active orchestrated capacity rather than raw agent count:

- a monthly platform fee includes projects, users and a small concurrency allowance;
- additional concurrent worker slots are subscription entitlements;
- usage records track execution minutes, storage and optional model pass-through separately;
- enterprise contracts add SSO, audit retention, private networking, BYOC/self-managed deployment and support SLAs;
- license enforcement must fail predictably without preventing customers from exporting their repositories and audit
  history.

Do not put hard subscription checks in the MIT coordination core. Commercial services can validate signed
entitlements at the control-plane boundary while offline core workflows remain usable.

## Commercial validation before major cloud spend

1. Complete one reproducible autonomous feature-delivery demo.
2. Run design-partner pilots in real repositories and measure human time, acceptance rate and cost.
3. Confirm buyers will pay for orchestration and governance rather than only model access.
4. Validate a customer-connected runner before building a multi-region worker cloud.
5. Obtain one paid pilot before investing in formal compliance certification.

The first enterprise offer can be an annual design-partner package: private deployment, onboarding, policy setup and
support. A broad self-serve SaaS subscription should follow demonstrated autonomous reliability, not precede it.

## Delivery phases

1. **Autonomous local MVP:** one lead, two runner types, isolated worktrees, reviewer loop, restart recovery and one
   browser-verified feature demo.
2. **Single-tenant remote runner:** durable API/controller, remote worker registration, encrypted credentials and
   operator console.
3. **Multi-tenant team cloud:** tenant boundaries, billing entitlements, quotas, audit export and managed upgrades.
4. **Enterprise BYOC:** AWS/Azure deployment modules, SSO/RBAC, private networking, customer-managed keys and support.
5. **Enterprise evidence:** penetration testing, SLO/DR exercises, compliance program and production case studies.
