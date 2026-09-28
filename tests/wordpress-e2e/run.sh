#!/usr/bin/env bash
# End-to-end test of nb-mcp-bridge safe updates against a real WordPress in Docker.
#   tests/wordpress-e2e/run.sh          # run and tear down
#   KEEP=1 tests/wordpress-e2e/run.sh   # leave the stack running for inspection
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=nb-bridge-e2e
DC="docker compose -p $PROJECT"
SITE=http://wp-e2e
HOST_URL=http://127.0.0.1:8089
cleanup() { [ "${KEEP:-}" = "1" ] || $DC down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
wp() { $DC exec -T cli wp "$@"; }

echo "==> starting WordPress"
$DC up -d --wait db wp-e2e >/dev/null
$DC up -d cli >/dev/null
for _ in $(seq 1 60); do wp core is-installed 2>/dev/null && break; wp db check >/dev/null 2>&1 && break; sleep 2; done
wp core install --url="$SITE" --title=e2e --admin_user=admin --admin_password=admin --admin_email=e2e@example.com --skip-email >/dev/null
wp user create mcp-bot bot@example.com --role=administrator >/dev/null
APP_PW=$(wp user application-password create mcp-bot e2e --porcelain)
AUTH=$(printf 'mcp-bot:%s' "$APP_PW" | base64 | tr -d '\n')

echo "==> building test plugin versions"
$DC exec -T -u 33 wp-e2e bash -s <<'SH'
set -e
make() { # version body
  d=$(mktemp -d); mkdir -p "$d/nb-e2e-test"
  printf '<?php\n/*\n * Plugin Name: NB E2E Test\n * Version: %s\n */\n%s\n' "$1" "$2" > "$d/nb-e2e-test/nb-e2e-test.php"
  (cd "$d" && php -r '$z=new ZipArchive();$z->open("p.zip",ZipArchive::CREATE);$z->addFile("nb-e2e-test/nb-e2e-test.php");$z->close();')
  mkdir -p /var/www/html/wp-content/uploads; cp "$d/p.zip" "/var/www/html/wp-content/uploads/nb-e2e-test-$1.zip"
}
make 1.0.0 'function nb_e2e_ok() { return true; }'
make 1.1.0 'function nb_e2e_ok() { return true; }'
make 1.2.0 'nb_e2e_this_function_does_not_exist();'
SH
wp plugin install "$SITE/wp-content/uploads/nb-e2e-test-1.0.0.zip" --activate >/dev/null 2>&1 \
  || { $DC exec -T -u 33 wp-e2e bash -c 'cd /var/www/html/wp-content/plugins && php -r "\$z=new ZipArchive();\$z->open(\"../uploads/nb-e2e-test-1.0.0.zip\");\$z->extractTo(\".\");"'; wp plugin activate nb-e2e-test >/dev/null; }

api() { # method path [json]
  curl -s -X "$1" "$HOST_URL/wp-json/nb-mcp/v1$2" -H "Host: wp-e2e" -H "Authorization: Basic $AUTH" \
    -H 'content-type: application/json' ${3:+-d "$3"}
}
jqn() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);console.log(typeof v==='string'?v:JSON.stringify(v))"; }
version() { wp plugin get nb-e2e-test --field=version; }
backups() { $DC exec -T wp-e2e bash -c 'find /var/www/nb-mcp-backups /var/www/html/wp-content/nb-mcp-backups -type f ! -name index.php ! -name .htaccess 2>/dev/null | wc -l' | tr -d ' '; }
# Let the web user create the backup root outside the web root (/var/www), like on Kinsta.
$DC exec -T wp-e2e bash -c 'mkdir -p /var/www/nb-mcp-backups && chown www-data:www-data /var/www/nb-mcp-backups'

echo "==> status reports safe_updates"
[ "$(api GET /status | jqn 'd.features.includes("safe_updates")')" = "true" ] || fail "status has no safe_updates feature"

echo "==> invalid health path is rejected"
[ "$(api POST /updates/plugins '{"plugins":["nb-e2e-test/nb-e2e-test.php"],"safe":true,"health_paths":["//evil.example"]}' | jqn 'd.code')" = "rest_invalid_param" ] || fail "//evil.example accepted"

echo "==> path traversal in plugin ids never reaches the filesystem"
MARK=$($DC exec -T wp-e2e bash -c 'ls /var/www/nb-mcp-backups | wc -l' | tr -d ' ')
R=$(api POST /updates/plugins '{"plugins":["../../","../nb-e2e-test/nb-e2e-test.php"],"safe":true}')
[ "$(echo "$R" | jqn 'd.results.every(r => r.success === false && r.backup === "none")')" = "true" ] || fail "traversal ids were processed: $R"
[ "$($DC exec -T wp-e2e bash -c 'find /var/www/nb-mcp-backups -mindepth 2 | wc -l' | tr -d ' ')" = "0" ] || fail "traversal created backup files"

echo "==> safe update to a broken version is rolled back"
wp option update nb_e2e_offer fatal >/dev/null
R=$(api POST /updates/plugins '{"plugins":["nb-e2e-test/nb-e2e-test.php"],"safe":true,"health_paths":["/does-not-exist-already/"]}')
echo "$R" | jqn 'd.results[0]'
[ "$(echo "$R" | jqn 'd.results[0].rolled_back')" = "true" ] || fail "not rolled back"
[ "$(echo "$R" | jqn 'd.results[0].backup')" = "created" ] || fail "no backup"
[ "$(echo "$R" | jqn '!!d.results[0].rollback_error')" = "false" ] || fail "rollback reported an error"
[ "$(echo "$R" | jqn 'd.results[0].health.checks.find(c=>c.target==="/does-not-exist-already/").ignored')" = "true" ] || fail "pre-existing 404 not ignored"
[ "$(version)" = "1.0.0" ] || fail "version after rollback is $(version)"
wp plugin is-active nb-e2e-test || fail "plugin not active after rollback"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: wp-e2e' "$HOST_URL/")" = "200" ] || fail "site not healthy after rollback"
[ "$(backups)" = "0" ] || fail "backup not cleaned up after successful rollback"
[ "$($DC exec -T wp-e2e bash -c 'test -d /var/www/html/wp-content/nb-mcp-backups && echo yes || echo no')" = "no" ] || fail "backups were stored inside the web root"
[ "$(echo "$R" | jqn 'd.results[0].health.checks.find(c=>c.target==="error_log").ok')" = "false" ] || fail "error log fatal not detected"

echo "==> safe update to a good version succeeds and removes the backup"
wp option update nb_e2e_offer good >/dev/null
R=$(api POST /updates/plugins '{"plugins":["nb-e2e-test/nb-e2e-test.php"],"safe":true}')
echo "$R" | jqn 'd.results[0]'
[ "$(echo "$R" | jqn 'd.results[0].success')" = "true" ] || fail "good update failed"
[ "$(echo "$R" | jqn 'd.results[0].rolled_back')" = "false" ] || fail "good update rolled back"
[ "$(version)" = "1.1.0" ] || fail "version after good update is $(version)"
[ "$(backups)" = "0" ] || fail "backup left behind"

echo "==> without safe mode the broken update stays (old behaviour unchanged)"
wp option update nb_e2e_offer fatal >/dev/null
R=$(api POST /updates/plugins '{"plugins":["nb-e2e-test/nb-e2e-test.php"]}')
[ "$(echo "$R" | jqn 'd.results[0].backup === undefined')" = "true" ] || fail "unsafe run made a backup"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: wp-e2e' "$HOST_URL/")" = "500" ] || fail "expected broken site without safe mode"

echo "==> repair the site (a fully fatal site cannot answer REST at all — why restore must be in-request)"
wp --skip-plugins plugin deactivate nb-e2e-test >/dev/null
wp option update nb_e2e_offer "" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: wp-e2e' "$HOST_URL/")" = "200" ] || fail "site not repaired"

echo "==> safe mode refuses to run when the homepage already fails"
wp option update nb_e2e_break_front 1 >/dev/null
R=$(api POST /updates/plugins '{"plugins":["nb-e2e-test/nb-e2e-test.php"],"safe":true}')
[ "$(echo "$R" | jqn 'd.code')" = "nb_mcp_site_unhealthy" ] || fail "expected nb_mcp_site_unhealthy, got $R"
wp option delete nb_e2e_break_front >/dev/null

echo "==> no backup directories left behind"
[ "$(backups)" = "0" ] || fail "backups left"

echo "ALL E2E CHECKS PASSED"
