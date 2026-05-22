# Package.json Reference Template

Every Backstage package.json must include these fields (verified against `plugins/catalog*/package.json`):

```json
{
  "name": "@backstage/plugin-<id>",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "private": true,
  "description": "Feature description",
  "backstage": {
    "role": "<role>",
    "pluginId": "<id>",
    "pluginPackages": [
      "@backstage/plugin-<id>",
      "@backstage/plugin-<id>-backend",
      "@backstage/plugin-<id>-common",
      "@backstage/plugin-<id>-node",
      "@backstage/plugin-<id>-react"
    ]
  },
  "publishConfig": { "access": "public" },
  "keywords": ["backstage"],
  "homepage": "https://backstage.io",
  "repository": {
    "type": "git",
    "url": "https://github.com/backstage/backstage",
    "directory": "plugins/<id>"
  },
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts",
    "./alpha": "./src/alpha/index.ts",
    "./package.json": "./package.json"
  },
  "main": "src/index.ts",
  "types": "src/index.ts",
  "typesVersions": {
    "*": {
      "alpha": ["src/alpha/index.ts"],
      "package.json": ["package.json"]
    }
  },
  "files": ["dist"],
  "scripts": {
    "start": "backstage-cli package start",
    "build": "backstage-cli package build",
    "lint": "backstage-cli package lint",
    "test": "backstage-cli package test",
    "clean": "backstage-cli package clean",
    "prepack": "backstage-cli package prepack",
    "postpack": "backstage-cli package postpack"
  },
  "dependencies": {},
  "devDependencies": {
    "@backstage/cli": "workspace:^",
    "@backstage/test-utils": "workspace:^"
  },
  "peerDependencies": {
    "react": "^16.13.1 || ^17.0.0 || ^18.0.0",
    "react-dom": "^16.13.1 || ^17.0.0 || ^18.0.0",
    "react-router-dom": "^6.3.0"
  },
  "peerDependenciesMeta": {
    "@types/react": { "optional": true }
  }
}
```

## Package-specific additions

### React package
```json
{
  "exports": {
    ".": "./src/index.ts",
    "./alpha": "./src/alpha/index.ts",
    "./testUtils": "./src/testUtils.ts",
    "./package.json": "./package.json"
  },
  "typesVersions": {
    "*": {
      "alpha": ["src/alpha/index.ts"],
      "testUtils": ["src/testUtils.ts"],
      "package.json": ["package.json"]
    }
  }
}
```

### Backend package
```json
{
  "scripts": {
    "generate": "backstage-repo-tools package schema openapi generate --server --client-package plugins/<id>-react"
  },
  "dependencies": {
    "@backstage/backend-openapi-utils": "workspace:^"
  }
}
```

### Common + Node packages
No `peerDependencies` needed (backend-only packages).
