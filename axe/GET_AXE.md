# Download axe-core

Run ONE of these commands in this folder:

```bash
# Option 1 — npm (recommended)
npm pack axe-core && tar xf axe-core-*.tgz && cp package/axe.min.js . && rm -rf package axe-core-*.tgz

# Option 2 — curl
curl -L https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js -o axe.min.js

# Option 3 — npx
npx --yes axe-core-cli --version  # installs axe-core as side-effect
# Then: cp node_modules/axe-core/axe.min.js .
```

The file `axe.min.js` must be present in this folder before loading the extension.
