#!/bin/bash
set -e

# Usage: ./release.sh <version> "<release notes>"
# Example: ./release.sh 1.9.1 "Fix JSON flash issue"

VERSION=$1
NOTES=$2

if [ -z "$VERSION" ] || [ -z "$NOTES" ]; then
    echo "Usage: ./release.sh <version> \"<release notes>\""
    echo "Example: ./release.sh 1.9.1 \"Fix JSON flash issue\""
    exit 1
fi

echo "=== Releasing version $VERSION ==="

# 1. Clean up existing release/tag if they exist
echo "Cleaning up existing release/tag if present..."
gh release delete "$VERSION" --yes 2>/dev/null || true
git push origin --delete "$VERSION" 2>/dev/null || true
git tag -d "$VERSION" 2>/dev/null || true

# 2. Get current version from manifest.json
CURRENT_VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\([^"]*\)".*/\1/')

# 3. Only update version files if version is different
if [ "$CURRENT_VERSION" != "$VERSION" ]; then
    echo "Updating version from $CURRENT_VERSION to $VERSION..."

    # Update manifest.json
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json

    # Update package.json
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json

    # Update versions.json (add new version if not exists)
    if ! grep -q "\"$VERSION\"" versions.json; then
        sed -i '' "s/}$/,\"$VERSION\":\"1.4.0\"}/" versions.json
    fi
else
    echo "Version already set to $VERSION"
fi

# 4. Build
echo "Building..."
npm run build

# 5. Check if there are changes to commit
if git diff --quiet && git diff --cached --quiet; then
    echo "No changes to commit, using existing HEAD"
else
    echo "Committing..."
    git add -A
    git commit -m "release: $VERSION - $NOTES"
fi

# 6. Tag
echo "Tagging $VERSION..."
git tag "$VERSION"

# 7. Push
echo "Pushing to origin..."
git push origin main --tags

# 8. Create GitHub release
echo "Creating GitHub release..."
gh release create "$VERSION" main.js manifest.json styles.css --title "$VERSION" --notes "$NOTES"

echo ""
echo "=== Done! Released $VERSION ==="
echo "https://github.com/Arunes007/vectrola-sync/releases/tag/$VERSION"
