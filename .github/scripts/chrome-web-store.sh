#!/usr/bin/env bash
# Uploads a zip to the review-ratio item of the Chrome Web Store and submits it for review, with
# the Chrome Web Store API v2 and curl alone. Run by the Release workflow on version tags.
#
#   chrome-web-store.sh <zip> <version>
#
# Secrets, as environment variables: CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_CLIENT_ID,
# CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN. Setup in docs/chrome-web-store.md.
#
# Endpoints (https://developer.chrome.com/docs/webstore/api/reference/rest, and the discovery
# document https://chromewebstore.googleapis.com/$discovery/rest?version=v2):
#   POST https://oauth2.googleapis.com/token                                  refresh token → access token
#   POST https://chromewebstore.googleapis.com/upload/v2/publishers/P/items/I:upload
#   GET  https://chromewebstore.googleapis.com/v2/publishers/P/items/I:fetchStatus
#   POST https://chromewebstore.googleapis.com/v2/publishers/P/items/I:publish
set -euo pipefail

zip=$1
version=$2
# Overridable to try the script against a local stand-in.
api=${CWS_API_URL:-https://chromewebstore.googleapis.com}
token_url=${CWS_TOKEN_URL:-https://oauth2.googleapis.com/token}
item="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
response=$(mktemp)
token=''

fail() {
  echo "::error title=Chrome Web Store::$1"
  exit 1
}

# call METHOD URL [curl options…]: leaves the body in $response; stops on any answer but 2xx and
# shows the API's error.
call() {
  local method=$1 url=$2 status
  shift 2
  status=$(curl -sS -X "$method" -o "$response" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" "$@" "$url") || fail "$method $url: no answer"
  if [[ $status != 2* ]]; then
    fail "$method $url answered HTTP $status: $(jq -c '.error // .' "$response" 2>/dev/null || cat "$response")"
  fi
}

# The access token lasts an hour, longer than this job.
status=$(curl -sS -o "$response" -w '%{http_code}' -X POST "$token_url" \
  --data-urlencode "client_id=${CWS_CLIENT_ID}" \
  --data-urlencode "client_secret=${CWS_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${CWS_REFRESH_TOKEN}" \
  --data-urlencode 'grant_type=refresh_token') || fail "${token_url}: no answer"
token=$(jq -r '.access_token // empty' "$response" 2>/dev/null || true)
if [[ $status != 2* || -z $token ]]; then
  # Google's error body names the problem (invalid_grant, invalid_client) and holds no secret.
  fail "refreshing the access token answered HTTP $status: $(cat "$response")"
fi
echo "::add-mask::${token}"

echo "Uploading ${zip} (${version}) to item ${CWS_EXTENSION_ID}"
call POST "${api}/upload/v2/${item}:upload" -T "$zip"
jq . "$response"
state=$(jq -r '.uploadState // empty' "$response")
for _ in $(seq 1 30); do
  # The reference names the pending state IN_PROGRESS; the guide's prose says UPLOAD_IN_PROGRESS.
  [[ $state == IN_PROGRESS || $state == UPLOAD_IN_PROGRESS ]] || break
  sleep 10
  call GET "${api}/v2/${item}:fetchStatus"
  state=$(jq -r '.lastAsyncUploadState // empty' "$response")
  echo "upload: ${state}"
done
# A version that is not higher than the item's last upload fails here, with the API's reason.
[[ $state == SUCCEEDED ]] || fail "upload ended in state ${state:-unknown}: $(jq -c . "$response")"
uploaded=$(jq -r '.crxVersion // empty' "$response")
if [[ -n $uploaded && $uploaded != "$version" ]]; then
  fail "the store read version ${uploaded} from the zip, expected ${version}"
fi

echo 'Submitting for review'
call POST "${api}/v2/${item}:publish" -H 'Content-Type: application/json' \
  -d '{"publishType":"DEFAULT_PUBLISH"}'
jq . "$response"
jq -r '.warningInfo.warnings[]? | "::warning title=Chrome Web Store::\(.)"' "$response"
state=$(jq -r '.state // empty' "$response")
case $state in
  PENDING_REVIEW | STAGED | PUBLISHED | PUBLISHED_TO_TESTERS) ;;
  *) fail "publish answered state ${state:-unknown}: $(jq -c . "$response")" ;;
esac

call GET "${api}/v2/${item}:fetchStatus"
jq . "$response"
if [[ $(jq -r '.takenDown // false' "$response") == true ]]; then
  fail 'the item is taken down for a policy violation: see the developer dashboard'
fi
if [[ $(jq -r '.warned // false' "$response") == true ]]; then
  echo '::warning title=Chrome Web Store::the item has a policy warning: see the developer dashboard'
fi
echo "::notice title=Chrome Web Store::${version} submitted: ${state}. Every version is reviewed before it goes live."
