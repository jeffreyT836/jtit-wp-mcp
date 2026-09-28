#!/usr/bin/env bash
# End-to-end test of nb-mcp-bridge Site Health + multisite routes against a real
# WordPress multisite (subdirectory) in Docker.
#   tests/wordpress-e2e/run-network.sh          # run and tear down
#   KEEP=1 tests/wordpress-e2e/run-network.sh   # leave the stack running for inspection
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=nb-bridge-e2e-network
DC="docker compose -p $PROJECT"
HOST_URL=http://127.0.0.1:8089
cleanup() { [ "${KEEP:-}" = "1" ] || $DC down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
wp() { $DC exec -T cli wp "$@"; }

echo "==> starting WordPress multisite"
$DC up -d --wait db wp-e2e >/dev/null
$DC up -d cli >/dev/null
for _ in $(seq 1 60); do wp db check >/dev/null 2>&1 && break; sleep 2; done
wp core multisite-install --url=http://wp-e2e --title=network --admin_user=admin --admin_password=admin --admin_email=e2e@example.com --skip-email >/dev/null
wp user create mcpbot bot@example.com --porcelain >/dev/null
wp super-admin add mcpbot >/dev/null
wp site create --slug=sub1 --title="Sub Een" --porcelain >/dev/null
wp user set-role mcpbot administrator --url=http://wp-e2e/sub1/ >/dev/null 2>&1 || wp user add-role mcpbot administrator --url=http://wp-e2e/sub1/ >/dev/null
wp user create janvries jan@example.com --role=editor --url=http://wp-e2e/sub1/ --porcelain >/dev/null
JAN=$(wp user get janvries --field=ID)
BOT=$(wp user get mcpbot --field=ID)
wp post create --post_title=VanJan --post_author="$JAN" --post_status=publish --url=http://wp-e2e/sub1/ >/dev/null
APP_PW=$(wp user application-password create mcpbot e2e --porcelain)
AUTH=$(printf 'mcpbot:%s' "$APP_PW" | base64 | tr -d '\n')

api() { # method route [json]
  curl -s -X "$1" "$HOST_URL/?rest_route=/nb-mcp/v1$2" -H "Host: wp-e2e" -H "Authorization: Basic $AUTH" \
    -H 'content-type: application/json' ${3:+-d "$3"}
}
jqn() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);console.log(typeof v==='string'?v:JSON.stringify(v))"; }

# Right after the fresh install the network sometimes answers the first request(s) as
# anonymous for about a second; once one authenticated request succeeds, all later ones
# do. Wait for that instead of asserting on a half-started install.
for _ in $(seq 1 20); do api GET /status | grep -q '"bridge_version"' && break; sleep 1; done

echo "==> status reports multisite and the new features"
S=$(api GET /status)
[ "$(echo "$S" | jqn 'd.multisite && d.features.includes("site_health") && d.features.includes("network")')" = "true" ] || fail "status: $S"

echo "==> site health runs the tests and leaks no paths"
H=$(api GET '/site-health&include_sizes=1')
[ "$(echo "$H" | jqn 'd.tests.length > 10')" = "true" ] || fail "too few tests: $(echo "$H" | head -c 400)"
[ "$(echo "$H" | jqn 'd.summary.good + d.summary.recommended + d.summary.critical === d.tests.length')" = "true" ] || fail "summary mismatch"
[ "$(echo "$H" | jqn 'd.tests.every(t => ["good","recommended","critical"].includes(t.status) && t.label && !/<[a-z]/i.test(t.description))')" = "true" ] || fail "test rows not normalized"
[ "$(echo "$H" | jqn 'typeof d.info.wp_version === "string" && d.info.multisite === true')" = "true" ] || fail "info missing"
echo "$H" | grep -q '/var/www/html' && fail "site health leaks the install path"
[ "$(echo "$H" | jqn '/^(MariaDB|MySQL) [0-9]+[.][0-9]+([.][0-9]+)?$/.test(d.info.db_server)')" = "true" ] || fail "db banner not reduced: $(echo "$H" | jqn 'd.info.db_server')"
echo "$H" | jqn 'd.summary'

echo "==> network sites"
N=$(api GET /network/sites)
[ "$(echo "$N" | jqn 'd.multisite && d.total === 2 && d.sites.some(s => s.is_main) && d.sites.some(s => s.name === "Sub Een")')" = "true" ] || fail "network sites: $N"
SUB=$(echo "$N" | jqn 'd.sites.find(s => s.name === "Sub Een").blog_id')

echo "==> subsite detail and roles"
D=$(api GET "/network/sites/$SUB")
[ "$(echo "$D" | jqn 'd.name === "Sub Een" && d.counts.posts >= 1 && d.counts.users >= 2 && typeof d.theme.name === "string"')" = "true" ] || fail "detail: $D"
[ "$(api GET "/network/sites/$SUB/roles" | jqn 'd.roles.some(r => r.slug === "editor")')" = "true" ] || fail "roles"
[ "$(api GET /network/sites/999 | jqn 'd.code')" = "nb_mcp_site_not_found" ] || fail "unknown blog accepted"

echo "==> subsite users: list, create, duplicate"
U=$(api GET "/network/sites/$SUB/users")
[ "$(echo "$U" | jqn 'd.users.some(u => u.username === "janvries" && u.roles.includes("editor")) && d.me > 0')" = "true" ] || fail "users: $U"
C=$(api POST "/network/sites/$SUB/users" '{"username":"marie","email":"marie@example.com","password":"Zeer-Geheim-Wachtwoord-42!","role":"author","first_name":"Marie"}')
[ "$(echo "$C" | jqn 'd.username === "marie" && d.roles.includes("author")')" = "true" ] || fail "create: $C"
echo "$C" | grep -q 'Zeer-Geheim' && fail "password echoed back"
wp user check-password marie 'Zeer-Geheim-Wachtwoord-42!' || fail "new user cannot log in"
[ "$(wp user list --url=http://wp-e2e/sub1/ --field=user_login | grep -c '^marie$')" = "1" ] || fail "marie not on subsite"
[ "$(wp user list --field=user_login | grep -c '^marie$')" = "0" ] || fail "marie was also added to the main site"
[ "$(api POST "/network/sites/$SUB/users" '{"username":"marie","email":"x@example.com","password":"Zeer-Geheim-Wachtwoord-42!","role":"author"}' | jqn 'd.code')" = "existing_user_login" ] || fail "duplicate accepted"
[ "$(api POST "/network/sites/$SUB/users" '{"username":"Kees-X","email":"k@example.com","password":"Zeer-Geheim-Wachtwoord-42!","role":"author"}' | jqn 'd.code')" = "nb_mcp_invalid_network_username" ] || fail "invalid network username accepted"
[ "$(api POST "/network/sites/$SUB/users" '{"username":"kees","email":"kees@example.com","password":"Zeer-Geheim-Wachtwoord-42!","role":"bestaatniet"}' | jqn 'd.code')" = "rest_user_invalid_role" ] || fail "bad role accepted"

echo "==> subsite users: remove with reassignment, guards"
[ "$(api POST "/network/sites/$SUB/users/$BOT/remove" "{\"reassign\":$JAN}" | jqn 'd.code')" = "nb_mcp_cannot_remove_self" ] || fail "self removal allowed"
R=$(api POST "/network/sites/$SUB/users/$JAN/remove" "{\"reassign\":$BOT}")
[ "$(echo "$R" | jqn 'd.removed === true && d.user.username === "janvries"')" = "true" ] || fail "remove: $R"
[ "$(wp user list --url=http://wp-e2e/sub1/ --field=user_login | grep -c '^janvries$')" = "0" ] || fail "janvries still on subsite"
wp user get janvries --field=ID >/dev/null || fail "jan's network account was deleted"
[ "$(wp post list --url=http://wp-e2e/sub1/ --title=VanJan --field=post_author)" = "$BOT" ] || fail "content not reassigned"

echo "==> without an Application Password the routes are refused"
[ "$(curl -s "$HOST_URL/?rest_route=/nb-mcp/v1/network/sites" -H 'Host: wp-e2e' | jqn 'd.code')" != "" ] || fail "anonymous request answered"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$HOST_URL/?rest_route=/nb-mcp/v1/site-health" -H 'Host: wp-e2e')" != "200" ] || fail "anonymous site health allowed"

echo "OK: all network/site-health checks passed"
