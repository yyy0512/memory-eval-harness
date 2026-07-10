```markdown
# VitalPulse CloudCare API  
## Security & Compliance White-Paper  

_Last updated: 2024-04-27_  
_Document owner: Chief Security Officer (security@vitalpulse.health)_

---

### 1. Executive Summary
VitalPulse CloudCare API is engineered to meet—and exceed—the technical, physical, and administrative safeguards prescribed by HIPAA/HITECH, GDPR, and ISO 27001. The platform is built on AWS’ secure-by-design services (Lambda, DynamoDB, API Gateway, KMS) and follows industry best practices such as the AWS Well-Architected Framework, NIST SP 800-53 rev5, and CSA STAR Level 2 controls.

---

### 2. Regulatory Landscape
| Regulation | Article / Safeguard | CloudCare Alignment |
|------------|--------------------|---------------------|
| HIPAA / HITECH | §164.306, §164.312(a)(2)(iv) | End-to-end AES-256 encryption, TLS 1.2+, least-privilege IAM |
| GDPR | Art. 32, Art. 35 DPIA | Data residency controls, privacy impact assessments |
| ISO 27001 | A.12.4, A.14.1 | Continuous monitoring, secure SDLC |
| PCI-DSS (if processing payments) | Req. 10, Req. 12 | Segmented network VPC, tokenized card storage |

---

### 3. Shared Responsibility Model
AWS manages the security _of_ the cloud (physical data centers, networking, hypervisor). VitalPulse controls security _in_ the cloud (identity, application code, patching, data protection). A Business Associate Agreement (BAA) is executed with AWS and downstream sub-processors.

---

### 4. Defense-in-Depth Controls

#### 4.1 Data Protection
* **In Transit:**  
  * All public endpoints require TLS 1.2+ with modern ciphers (ECDHE_RSA_WITH_AES_256_GCM_SHA384).  
  * Strict-Transport-Security header (max-age = 63072000).  
* **At Rest:**  
  * DynamoDB tables encrypted with AWS KMS customer-managed keys (CMKs).  
  * S3 object locks + versioning for immutable audit logs.  
* **Key Management:**  
  * CMKs use automatic key rotation (every 365 days).  
  * Dual-admin policy enforced through KMS key policies and AWS SSO.

```hcl
# Terraform — CMK definition (FIPS 140-2 compliant)
resource "aws_kms_key" "vitals_cmk" {
  description             = "VitalPulse master key"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  policy = data.aws_iam_policy_document.cmk.json
}
```

#### 4.2 Identity & Access Management
* SMART on FHIR / OAuth 2.1 flows; scopes follow the UDAP Tiered OAuth guidelines.  
* Fine-grained permissions via AWS IAM Roles and AWS STS session policies.  
* SCIM v2 integration for automated clinician provisioning/de-provisioning.  

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "LeastPrivilegeLambdaDynamo",
    "Effect": "Allow",
    "Action": [
      "dynamodb:GetItem",
      "dynamodb:PutItem"
    ],
    "Resource": "arn:aws:dynamodb:us-east-1:123456789012:table/PatientVitals"
  }]
}
```

#### 4.3 Application-Layer Security
* **Request Validation:** JSON payloads schema-validated against HL7 FHIR R4 using the HAPI FHIR validator.  
* **Rate Limiting:** API Gateway usage plans (10 req/s baseline, burst = 50, adjustable per vendor).  
* **Error Handling:** Writer Lambdas implement structured Problem+JSON responses and never expose stack traces.  
* **Input Sanitization:** OWASP ESAPI sanitizers for user-generated strings; DynamoDB reserved keyword escaping.

---

### 5. Logging & Monitoring
| Stream | Medium | Retention | Purpose |
|--------|--------|-----------|---------|
| API Access Logs | CloudWatch Logs | 7 years (WORM) | Forensic analysis |
| IAM Auth | AWS CloudTrail | 7 years (WORM) | Compliance, audit |
| Lambda Metrics | CloudWatch Metrics | 15 months | Performance, SLOs |
| Traces | AWS X-Ray | 30 days | Distributed tracing |

All logs are shipped asynchronously to a central Security Lake (S3 + Lake Formation) with object-locking and KMS encryption.

---

### 6. Continuous Compliance Automation
1. **Pipeline Security Gates**  
   * SCA (OWASP Dependency-Check) → SAST (SonarQube, Semgrep) → IaC Scanning (Checkov).  
2. **Runtime Controls**  
   * AWS Config Rules (`restricted-ssh`, `dynamodb-table-encrypted`).  
   * AWS Security Hub with HITRUST CSF standard enabled.  
3. **Alerting**  
   * GuardDuty → EventBridge → PagerDuty → Slack #security-alerts.  

---

### 7. Vulnerability Management
* Weekly dynamic scans using Burp Suite Enterprise.  
* Monthly container image scans with Amazon Inspector v2.  
* Critical patches applied within **24 hours** (per policy VP-P-102).  

---

### 8. Business Continuity & Disaster Recovery
| Tier | RPO | RTO | Strategy |
|------|-----|-----|----------|
| Telemetry Write Path | 15 minutes | 1 hour | DynamoDB global tables (us-east-1 ↔ us-west-2) |
| Medication Orders | 0 minutes | 15 minutes | Point-in-time recovery, cross-region replication |
| Static Assets | 4 hours | 24 hours | S3 Cross-Region Replication, CloudFront fallback |

Quarterly fail-over drills are executed and evidenced for auditors.

---

### 9. Incident Response
* 24x7 Security Operations Center (SOC) with on-call escalation.  
* Playbooks stored in PagerDuty Runbook automation; aligned with NIST 800-61r2.  
* All incidents are classified (SEV-1…SEV-4), post-mortems completed within 5 business days.

---

### 10. Penetration Testing & Bug Bounty
* Annual third-party penetration test (CREST-accredited).  
* Public bug bounty via HackerOne with a minimum payout of \$500 per valid report.  

---

### 11. Data Privacy & Patient Rights
* Data subject access requests (DSAR) handled within 30 days.  
* PHI is stored only in designated compliance scope accounts; de-identified datasets use Tokenized IDs (NIST 800-188).  

---

### 12. Appendices

#### 12.1 Cipher Suite Inventory
```
TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 (0xC030)
TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 (0xC02F)
```

#### 12.2 ASCII Architecture Diagram
```
+-----------+      +-------------+      +-----------+
|  Client   | ---> | API Gateway | ---> |  Lambda   |
+-----------+      +-------------+      +-----------+
                                       |  DynamoDB |
                                       +-----------+
```

#### 12.3 Change Log
| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2023-10-14 | 1.0 | CISO | Initial draft |
| 2024-04-27 | 1.3 | SecOps | Added Security Lake & Inspector v2 |

---

For any security inquiries or to obtain signed compliance reports (HITRUST, SOC 2 Type II), contact security@vitalpulse.health.
```