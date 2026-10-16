# WP Fleet Client API v1 (contract)

Read-only JSON API served by the **wp-dashboard** process (repo `~/Projects/jtit-wp-mcp`) for the
macOS menubar app "WP Fleet Bar". Single source of truth for both sides.

- Base URL: `https://wp-dashboard.jtit.nl`
- Prefix: `/client-api/v1`
- Auth: `Authorization: Bearer <DASHBOARD_CLIENT_TOKEN>` (≥ 32 chars, read-only token, separate
  from `DASHBOARD_INGEST_TOKEN`). Timing-safe compare.
- When `DASHBOARD_CLIENT_TOKEN` is not configured the whole prefix answers
  `503 {"success":false,"error":"client api disabled"}`.
- Errors: `401 {"success":false,"error":"unauthorized"}`, `404 {"success":false,"error":"unknown site \"x\""}`.
- `Cache-Control: no-store`. Only `GET`. No cookies, no CSRF (bearer only).

## GET /client-api/v1/fleet

```jsonc
{
  "success": true,
  "data": {
    "apiVersion": 1,
    "generatedAt": "2026-10-16T09:40:00.000Z",
    "vulnerabilityFeed": {
      "enabled": true,                 // false when WORDFENCE_API_KEY is not set
      "source": "wordfence-intelligence-v3-production",
      "updatedAt": "2026-10-16T06:00:00.000Z", // null when never loaded
      "records": 31234,                // null when never loaded
      "error": null                    // Dutch message when the last refresh failed
    },
    "summary": {
      "sites": 12, "ok": 9, "warning": 2, "critical": 1, "unknown": 0,
      "pendingUpdates": 17,            // core + plugins + themes over all sites
      "vulnerabilities": 3,            // non-informational matches over all sites
      "criticalVulnerabilities": 1     // cvssScore >= 7.0 (or rating High/Critical)
    },
    "sites": [
      {
        "id": "example-nl",
        "name": "Example",
        "url": "https://example.nl",
        "tags": ["klant"],
        "hasPassword": true,
        "multisite": false,
        "state": "critical",           // "ok" | "warning" | "critical" | "unknown"
        "issues": [
          { "severity": "critical", "code": "vulnerability", "message": "Contact Form 7 5.8.1: CVE-2024-1234 (CVSS 8.1, High)" },
          { "severity": "warning",  "code": "updates",       "message": "3 plugin-updates beschikbaar" }
        ],
        "status": {                    // = SiteStatus from src/dashboard/snapshots.ts (all optional)
          "collectedAt": "2026-10-16T09:00:00.000Z",
          "reachable": true, "isAdmin": true, "bridge": "1.2.0",
          "wpVersion": "6.8.3", "phpVersion": "8.3.12",
          "error": null,
          "updates": { "core": 0, "plugins": 3, "themes": 0 },
          "updatesError": null,
          "health": { "critical": 0, "recommended": 2, "good": 18 },
          "healthError": null
        },
        "updates": {                   // null when no updates snapshot exists
          "checkedAt": "2026-10-16T09:00:00.000Z",
          "core":    [{ "current": "6.8.2", "version": "6.8.3", "type": "minor" }],
          "plugins": [{ "slug": "contact-form-7", "name": "Contact Form 7", "currentVersion": "5.8.1", "newVersion": "6.0.1" }],
          "themes":  [{ "slug": "astra", "name": "Astra", "currentVersion": "4.6.0", "newVersion": "4.8.1" }]
        },
        "vulnerabilities": {           // null when never scanned
          "scannedAt": "2026-10-16T06:05:00.000Z",
          "error": null,
          "items": [
            {
              "id": "848ccbdc-c6f1-480f-a272-cd459e706713",
              "title": "Contact Form 7 <= 5.8.1 - Reflected XSS",
              "softwareType": "plugin",  // "plugin" | "theme" | "core"
              "slug": "contact-form-7",
              "softwareName": "Contact Form 7",
              "installedVersion": "5.8.1",
              "cve": "CVE-2024-1234",    // nullable
              "cvssScore": 8.1,          // nullable
              "cvssRating": "High",      // nullable: None|Low|Medium|High|Critical
              "patched": true,
              "patchedVersions": ["5.8.2"],
              "remediation": "Update to version 5.8.2, or a newer patched version", // nullable
              "reference": "https://www.wordfence.com/threat-intel/vulnerabilities/id/848ccbdc-...", // nullable
              "published": "2024-01-09 00:00:00" // nullable, Wordfence format (UTC)
            }
          ]
        }
      }
    ]
  }
}
```

### Issue rules (server derives `issues` + `state`; order: critical → warning → info)

| code | severity | when |
|---|---|---|
| `no-password` | critical | site has no application password stored |
| `unreachable` | critical | `status.reachable === false` (message includes `status.error`) |
| `vulnerability` | critical | non-informational match with cvssScore ≥ 7.0 or rating High/Critical |
| `vulnerability` | warning | any other non-informational match |
| `core-update` | warning | `updates.core > 0` |
| `updates` | warning | plugin + theme updates > 0 |
| `health-critical` | warning | `health.critical > 0` |
| `stale` | info | newest `collectedAt` older than 6 hours, or no data at all |
| `check-failed` | info | `updatesError`, `healthError` or `vulnerabilities.error` present |

`state`: any critical → `critical`; else any warning → `warning`; else `reachable === true` → `ok`; else `unknown`.

Note: the MITRE/Defiant copyright notice is required when displaying records; the app shows a
"Data: Wordfence Intelligence (Defiant Inc.), CVE © MITRE" attribution line in the vulnerability view.

## GET /client-api/v1/sites/:id

Same object as one entry of `data.sites`, wrapped in `{ "success": true, "data": { ...site } }`.

## Server implementation notes (jtit-wp-mcp)

Clarifications of how the server fills in the contract; no fields are added or renamed.

- Every documented field is always present. Unknown values are `null`, never omitted (this
  includes all `status` fields).
- `vulnerabilities.items` contains only non-informational matches. Informational Wordfence
  records are never listed.
- A failed scan keeps the items of the last successful scan. `error` is then set and
  `scannedAt` is the time of the failed attempt.
- `updates` is present (with empty lists) when the newest update check failed; the failure is
  in `status.updatesError`.
- Methods other than `GET`/`HEAD` answer `405 {"success":false,"error":"method not allowed"}`;
  unknown paths under the prefix answer `404 {"success":false,"error":"not found"}`.
- The vulnerability feed is refreshed at most every 12 h (`VULN_FEED_REFRESH_HOURS`); sites are
  scanned every 6 h (`VULN_SCAN_INTERVAL_HOURS`) and on demand from the dashboard.
