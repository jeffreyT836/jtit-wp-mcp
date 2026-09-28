# n8n → WP Fleet Dashboard

`wp-fleet-sync.json` haalt elk uur `fleet_health` en `fleet_updates_report` op bij de MCP-server
en levert de resultaten aan het dashboard, dat ze toont op https://wp-dashboard.jtit.nl.

```
Elk uur → Tools → MCP: tool aanroepen → Resultaat uitpakken → Dashboard: data opslaan
           (http://wp-mcp:3000/mcp)                         (http://wp-dashboard:3001/api/ingest)
```

## Instellen

1. **Netwerk:** de n8n-container moet op het Docker-netwerk `traefik-network` zitten (daar
   draaien `wp-mcp` en `wp-dashboard`). Controleer met
   `docker inspect <n8n-container> -f '{{json .NetworkSettings.Networks}}'`.
   Het ingest-endpoint is bewust niet via internet bereikbaar.
2. **Credentials** (n8n → Credentials → New → *Header Auth*), waarden uit
   `/docker/jtit-wp-mcp/.env` op de server:
   | Naam in n8n | Header name | Value |
   |---|---|---|
   | `WP MCP token` | `Authorization` | `Bearer <MCP_HTTP_TOKEN>` |
   | `WP Dashboard ingest token` | `Authorization` | `Bearer <DASHBOARD_INGEST_TOKEN>` |
3. **Importeren:** Workflows → Import from File → `wp-fleet-sync.json`, koppel beide
   HTTP-nodes aan de juiste credential, test met *Execute workflow* en zet hem daarna op actief.

## Zelf uitbreiden

Elke MCP-tool kan erbij: voeg in de node **Tools** een item toe, bijv.
`{ json: { kind: 'fleet_user_audit', arguments: {} } }`. Het dashboard slaat elke `kind` op;
resultaten in fleet-vorm (`{ results: [{ site, ok, data }] }`) worden automatisch per site
opgesplitst en zijn te zien op de site-detailpagina. Data wordt 30 dagen bewaard.

Ingest-formaat (`POST /api/ingest`, JSON, max 1 MB):
```json
{ "kind": "fleet_health", "collectedAt": "2026-09-28T10:00:00Z", "data": { "...": "..." }, "site": "optioneel-site-id" }
```
`GET /api/sites` (zelfde token) geeft de lijst sites zonder geheimen.
