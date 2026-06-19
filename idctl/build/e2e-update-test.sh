#!/bin/bash
# End-to-end self-update test: build v0.1.0 (installed) + v0.2.0 (release),
# serve the release locally, stage via `idctl upgrade`, confirm next launch
# self-applies + re-execs into v0.2.0. Run from the idctl project root.
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
ROOT="$(pwd)"
W=/tmp/idctl-e2e
PORT=8731
rm -rf "$W"; mkdir -p "$W/bin" "$W/release"

bump() { node -e "const f='package.json',p=require('./'+f);p.version='$1';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"; }

echo "== build installed v0.1.0 =="
bump 0.1.0; node build/gen-version.mjs >/dev/null
bun build src/cli.tsx --compile --minify --target=bun-darwin-arm64 --outfile "$W/bin/idctl" >/dev/null 2>&1

echo "== build release v0.2.0 =="
bump 0.2.0; node build/gen-version.mjs >/dev/null
bun build src/cli.tsx --compile --minify --target=bun-darwin-arm64 --outfile "$W/release/idctl-darwin-arm64" >/dev/null 2>&1
SHA=$(shasum -a 256 "$W/release/idctl-darwin-arm64" | awk '{print $1}')

echo "== restore source to 0.1.0 =="
bump 0.1.0; node build/gen-version.mjs >/dev/null

cat > "$W/release/version.json" <<JSON
{ "version": "0.2.0", "tag": "v0.2.0", "notes_url": "http://127.0.0.1:$PORT/notes",
  "assets": [ { "os":"darwin","arch":"arm64","libc":null,"url":"http://127.0.0.1:$PORT/idctl-darwin-arm64","sha256":"$SHA" } ] }
JSON

cat > "$W/config.json" <<JSON
{ "version":1, "managers":[], "providers":[],
  "update": { "autoUpgrade": true, "updateManifestUrl": "http://127.0.0.1:$PORT/version.json", "checkIntervalHours": 12 } }
JSON
chmod 600 "$W/config.json"

# Tiny static server for the release dir.
node -e "const h=require('http'),f=require('fs'),p='$W/release';h.createServer((q,s)=>{const fp=p+(q.url==='/version.json'?'/version.json':'/idctl-darwin-arm64');try{s.end(f.readFileSync(fp))}catch(e){s.statusCode=404;s.end('nf')}}).listen($PORT,'127.0.0.1',()=>console.error('server up'))" &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1

export IDCTL_CONFIG="$W/config.json"
INST="$W/bin/idctl"
echo "== installed version =="; "$INST" help | head -1

echo "== idctl upgrade (stage) =="
"$INST" upgrade || echo "(upgrade exit $?)"
echo "-- pending.json present: $([ -f "$W/update/pending.json" ] && echo yes || echo NO)"
echo "-- staged file present: $(ls "$W"/bin/.idctl.new-* 2>/dev/null | wc -l | tr -d ' ')"

echo "== relaunch #1 (should self-apply + re-exec into v0.2.0) =="
"$INST" help 2>/tmp/e2e-stderr | head -1
echo "-- stderr:"; cat /tmp/e2e-stderr
echo "-- installed binary sha now matches release: $([ "$(shasum -a 256 "$INST" | awk '{print $1}')" = "$SHA" ] && echo YES || echo no)"
echo "-- pending cleared: $([ -f "$W/update/pending.json" ] && echo NO || echo yes)"

echo "== relaunch #2 (no upgrade, no loop) =="
"$INST" help 2>/tmp/e2e-stderr2 | head -1
echo "-- stderr empty (no re-apply): $([ -s /tmp/e2e-stderr2 ] && echo "NO: $(cat /tmp/e2e-stderr2)" || echo yes)"

echo "== dev-mode disabled check =="
(cd "$ROOT" && node bin/idctl.mjs upgrade 2>&1 | head -1)
echo "== DONE =="
