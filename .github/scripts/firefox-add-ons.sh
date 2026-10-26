#!/usr/bin/env bash
# Has addons.mozilla.org sign the Firefox build, unlisted (self-distributed), and publishes the
# signed file where Firefox installs and updates it from. Run by the Release workflow on version
# tags, from the repository root, after the tag's GitHub Release exists.
#
#   firefox-add-ons.sh <unsigned zip> <version> <tag>
#
# Secrets, as environment variables: AMO_JWT_ISSUER, AMO_JWT_SECRET. gh needs GH_TOKEN and GH_REPO.
# Setup in docs/firefox-add-ons.md.
#
#   1. web-ext sign submits the zip and the source of the checked-out commit to the unlisted
#      channel, and waits for the signed .xpi.
#   2. The tag's release gets it as review-ratio-<version>.xpi: the update link, never replaced.
#   3. The fixed release `firefox` gets it as review-ratio.xpi (the install link) with the
#      updates.json the manifest's update_url names, unless it already serves a newer version.
set -euo pipefail

zip=$1
version=$2
tag=$3
release=firefox
server=${GITHUB_SERVER_URL:-https://github.com}
work=$(mktemp -d)

fail() {
  echo "::error title=Firefox Add-ons::$1"
  exit 1
}

unzip -q "$zip" -d "$work/unsigned"
# The bundle is generated from TypeScript, so reviewers get the source it is built from.
git archive --format=zip --prefix=review-ratio/ -o "$work/source.zip" HEAD

echo "Signing ${zip} (${version}) on the unlisted channel"
WEB_EXT_API_KEY=$AMO_JWT_ISSUER WEB_EXT_API_SECRET=$AMO_JWT_SECRET pnpm exec web-ext sign \
  --source-dir "$work/unsigned" \
  --artifacts-dir "$work/signed" \
  --channel unlisted \
  --upload-source-code "$work/source.zip" ||
  fail "web-ext sign failed for ${version}: see the log above"

signed=("$work"/signed/*.xpi)
[[ ${#signed[@]} == 1 && -f ${signed[0]} ]] || fail "expected one signed .xpi, got: ${signed[*]}"
versioned="review-ratio-${version}.xpi"
cp "${signed[0]}" "$work/$versioned"
gh release upload "$tag" "$work/$versioned" --clobber
link="${server}/${GH_REPO}/releases/download/${tag}/${versioned}"

node packages/extension/scripts/firefox.mjs --version "$version" --xpi "$work/$versioned" \
  --link "$link" > "$work/updates.json"
cat "$work/updates.json"

notes() {
  cat <<EOF
The newest review-ratio for Firefox, signed by Mozilla: version ${version}, from ${server}/${GH_REPO}/releases/tag/${tag}.

To install, open ${server}/${GH_REPO}/releases/download/${release}/review-ratio.xpi in Firefox and click **Add**. Firefox updates it by itself from \`updates.json\`.

The \`${release}\` tag only anchors this release: its files change with every version tag.
EOF
}

if ! gh release view "$release" > /dev/null 2>&1; then
  # A prerelease never becomes Latest, which stays the newest Chrome build.
  gh release create "$release" --target "$(git rev-parse HEAD)" --prerelease --latest=false \
    --title 'review-ratio for Firefox' --notes "$(notes)"
fi

# Runs can finish out of order: never replace a newer version with an older one.
current=$(gh release download "$release" --pattern updates.json --output - 2> /dev/null |
  jq -r '.addons[]?.updates[0].version // empty' || true)
if [[ -n $current && $(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -1) != "$version" ]]; then
  echo "::notice title=Firefox Add-ons::${version} signed; the ${release} release keeps ${current}, which is newer."
  exit 0
fi

cp "$work/$versioned" "$work/review-ratio.xpi"
gh release upload "$release" "$work/review-ratio.xpi" "$work/updates.json" --clobber
gh release edit "$release" --notes "$(notes)"
echo "::notice title=Firefox Add-ons::${version} signed and published: ${server}/${GH_REPO}/releases/tag/${release}"
