# n8n → WP Fleet Dashboard

`wp-fleet-sync.json` haalt data op bij de MCP-server en levert die aan het dashboard, dat ze
toont op https://wp-dashboard.jtit.nl.

| Wanneer | MCP-tool | Wat je ziet in het dashboard |
|---|---|---|
| Elk uur | `fleet_health` | bereikbaar, admin-rechten, bridge, WP-/PHP-versie |
| Elk uur | `fleet_updates_report` | openstaande core/plugin/thema-updates (cache van WP) |
| Dagelijks 06:00 | `fleet_updates_report` + `refresh: true` | laat elke site opnieuw naar updates zoeken |
| Dagelijks 06:00 | `fleet_user_audit` (administrators) | alle admin-accounts per site (site-detailpagina) |
| Dagelijks 06:00 | `fleet_site_health` | WordPress Site Health per site (vereist nb-mcp-bridge 1.2.0) |
| Dagelijks 06:00 | `fleet_vulnerabilities` | bekende kwetsbaarheden in core, plugins en thema's (WPVulnerability) |

Na elke opslag beoordeelt het dashboard de data op meldingen (onbereikbaar, nieuwe admin,
kwetsbaarheid, …; zie README §10.1). Het antwoord van `/api/ingest` bevat
`alerts: { opened, resolved }`.

```
Elk uur ─────────► Tools (elk uur) ────┐
                                        ├─► MCP: tool aanroepen ─► Resultaat uitpakken ─► Dashboard: data opslaan
Dagelijks 06:00 ─► Tools (dagelijks) ──┘   (http://wp-mcp:3000/mcp)                     (http://wp-dashboard:3001/api/ingest)
```

Beide HTTP-nodes proberen het bij een fout één keer opnieuw. Mislukt een tool daarna nog,
dan faalt de run en zie je dat onder **Executions** (koppel eventueel een Error Workflow
voor een melding). Alle schema's draaien in tijdzone Europe/Amsterdam.

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

## Meldingen per e-mail (optioneel)

`wp-fleet-alerts.json` is een tweede workflow die meldingen van het dashboard ontvangt en per
e-mail doorstuurt. Voor Slack heb je hem niet nodig: zet dan een Slack incoming-webhook-URL
direct in `ALERT_WEBHOOK_URL`.

1. Importeer `wp-fleet-alerts.json`, open de node **Webhook: melding ontvangen** en koppel een
   *Header Auth*-credential (`Authorization` / `Bearer <een nieuw random token>`, bijv.
   `openssl rand -hex 32`).
2. Open **E-mail versturen**: koppel je SMTP-credential en vul afzender en ontvanger in.
3. Zet de workflow op actief en kopieer de **Production URL** van de webhook-node. Intern op het
   Docker-netwerk is dat `http://<n8n-container>:5678/webhook/wp-fleet-alerts`.
4. Zet in `/docker/jtit-wp-mcp/.env` op de server:
   ```
   ALERT_WEBHOOK_URL=http://<n8n-container>:5678/webhook/wp-fleet-alerts
   ALERT_WEBHOOK_TOKEN=<hetzelfde token als in stap 1, zonder "Bearer ">
   DASHBOARD_PUBLIC_URL=https://wp-dashboard.jtit.nl
   ```
   en herstart het dashboard (`docker compose up -d wp-dashboard`).
5. Dashboard → **Instellingen → Testmelding versturen**.

## Zelf uitbreiden

Elke read-only MCP-tool kan erbij: voeg in een van de **Tools**-nodes een item toe, bijv.
`call('fleet_find_plugin', { query: 'woocommerce' })`. Het dashboard slaat elke `kind` op;
resultaten in fleet-vorm (`{ results: [{ site, ok, data }] }`) worden automatisch per site
opgesplitst en zijn te zien op de site-detailpagina. Data wordt 30 dagen bewaard.

Ingest-formaat (`POST /api/ingest`, JSON, max 1 MB):
```json
{ "kind": "fleet_health", "collectedAt": "2026-09-28T10:00:00Z", "data": { "...": "..." }, "site": "optioneel-site-id" }
```
`GET /api/sites` (zelfde token) geeft de lijst sites zonder geheimen.
