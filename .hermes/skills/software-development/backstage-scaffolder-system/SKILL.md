---
name: backstage-scaffolder-system
description: "Use when building Backstage Software Templates, writing custom scaffolder actions, configuring template parameters, or extending the scaffolder with modules. Covers template YAML format, built-in actions, custom action development, and the task lifecycle."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, scaffolder, templates, actions, software-templates]
    related_skills: [backstage-catalog-system, backstage-plugin-blueprint, backstage-core-services]
---

# Backstage Scaffolder System

## Overview

The Scaffolder creates new software projects from templates. 19 packages. Templates define YAML steps, each calling an action (fetch template, create repo, register in catalog). Built-in actions provided; custom actions created via modules.

## Template YAML Format

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: react-ssr-template
  title: React SSR Website
spec:
  owner: team-platform
  type: website
  parameters:
    - title: Project Details
      required: [name, owner]
      properties:
        name: { title: Name, type: string, ui:autofocus: true }
        owner: { title: Owner, type: string, ui:field: OwnerPicker }
        repoUrl: { title: Repository URL, type: string, ui:field: RepoUrlPicker, ui:options: { allowedHosts: [github.com] } }
  steps:
    - id: template
      name: Fetch template
      action: fetch:template
      input:
        url: ./template
        values:
          name: ${{ parameters.name }}
          owner: ${{ parameters.owner }}
    - id: publish
      name: Publish
      action: publish:github
      input:
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps['publish'].output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml
```

### Template Variables

- `${{ parameters.name }}` — User parameters from form
- `${{ steps['step-id'].output.field }}` — Previous step outputs

### Parameter Form ui:* Extensions

`ui:field` (OwnerPicker, RepoUrlPicker), `ui:widget` (textarea, password, radio), `ui:options`, `ui:autofocus`, `ui:order`, `ui:disabled`, `ui:readonly`.

## Built-in Actions

| Action | Purpose |
|---|---|
| `fetch:template` | Fetch directory, render Nunjucks with values |
| `fetch:plain` | Fetch file, render with values |
| `fetch:plainFile` | Fetch file as-is |
| `fetch:cookiecutter` | Cookiecutter template |
| `catalog:register` | Register entity in catalog |
| `catalog:write` | Write catalog-info.yaml |
| `fs:rename` | Rename files/directories |
| `fs:delete` | Delete files/directories |
| `debug:log` | Log message |
| `debug:wait` | Pause execution |

## Custom Actions

Create in `scaffolder-backend-module-*`:

```ts
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

export const myAction = createTemplateAction<{ name: string; count?: number }>({
  id: 'my-org:custom-action',
  description: 'Does something custom',
  schema: {
    input: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, count: { type: 'number', default: 1 } } },
    output: { type: 'object', properties: { result: { type: 'string' } } },
  },
  async handler(ctx) {
    ctx.logger.info(`Running for ${ctx.input.name}`);
    for (let i = 0; i < (ctx.input.count ?? 1); i++) { /* work */ }
    ctx.output('result', `Completed ${ctx.input.count} times`);
  },
});
```

### Register via Extension Point

```ts
env.registerInit({
  deps: { scaffolder: scaffolderActionsExtensionPoint },
  async init({ scaffolder }) { scaffolder.addAction(myAction); },
});
```

### Task Context (ctx)

`ctx.logger`, `ctx.output(key, value)`, `ctx.createTemporaryDirectory()`, `ctx.workspacePath`, `ctx.task.id`, `ctx.getInitiatorCredentials()`.

## Extension Points

| Point | Package | Purpose |
|---|---|---|
| `scaffolderActionsExtensionPoint` | `@backstage/plugin-scaffolder-node` | Register custom actions |
| `scaffolderTaskBrokerExtensionPoint` | `@backstage/plugin-scaffolder-node` | Override task execution |
| `scaffolderTemplatingExtensionPoint` | `@backstage/plugin-scaffolder-node` | Custom templating engines |

## Frontend Custom Fields

```tsx
export const MyCustomField: FieldExtensionComponent<string> = ({ onChange, rawErrors, required, formData }) => (
  <TextField label="My Field" value={formData} onChange={e => onChange(e.target.value)} error={rawErrors?.length > 0} required={required} />
);
```

Use in template: `ui:field: MyCustomField`

## Nunjucks Filters

`parseEntityRef(ref)`, `parseRepoUrl(url)`, `pick(obj, keys)`, `projectSlug(url)`.

## Configuration

```yaml
scaffolder:
  defaultTimeoutMinutes: 10
  experimental:
    enableBackstageUi: true  # BUI forms
```

## Custom Action Development

### Action Structure

```ts
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';

export function createMyCustomAction() {
  return createTemplateAction<{ name: string; dryRun?: boolean }>({
    id: 'my-company:custom-action',
    description: 'Performs a custom operation',
    schema: {
      input: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', title: 'Name', description: 'Resource name' },
          dryRun: { type: 'boolean', title: 'Dry Run', default: false },
        },
      },
      output: {
        type: 'object',
        properties: {
          resourceId: { type: 'string', title: 'Created resource ID' },
          url: { type: 'string', title: 'Resource URL' },
        },
      },
    },
    async handler(ctx) {
      const { name, dryRun } = ctx.input;
      ctx.logger.info(`Processing ${name}`);

      if (dryRun) {
        ctx.logger.info('Dry run: skipping actual creation');
        ctx.output('resourceId', 'dry-run-id');
        return;
      }

      // Access workspace files
      const workspacePath = ctx.workspacePath;
      const templateContent = await fs.readFile(`${workspacePath}/template.yaml`, 'utf-8');

      // Call external API
      const result = await fetch('https://api.example.com/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, template: templateContent }),
      }).then(r => r.json());

      // Set outputs for subsequent steps
      ctx.output('resourceId', result.id);
      ctx.output('url', result.url);
    },
  });
}
```

### Register Action via Module

```ts
// scaffolder-backend-module-custom/src/module.ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'custom-actions',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createMyCustomAction());
      },
    });
  },
});
```

### Template Parameter Types

```yaml
parameters:
  - title: Resource Configuration
    properties:
      name:
        type: string
        title: Resource Name
        ui:autofocus: true
        ui:options:
          rows: 5
      environment:
        type: string
        title: Environment
        enum: ['dev', 'staging', 'prod']
        default: dev
      region:
        type: string
        title: Region
        ui:field: OwnerPicker       # Custom field component
        ui:options:
          allowedKinds: ['Group']
      owner:
        type: string
        title: Owner
        ui:field: OwnerPicker
        ui:options:
          allowedKinds: ['Group']
      repoUrl:
        type: string
        title: Repository URL
        ui:field: RepoUrlPicker
        ui:options:
          allowedHosts: ['github.com']
```

### Task Lifecycle

```
Template selects → Parameters filled → Scaffolder task created
  → Step 1: action runs (has ctx.workspacePath)
  → Step 2: action runs (receives ctx.input + previous outputs)
  → Step N: final action
  → Task complete → Entity registered in catalog (if output entityRef)
```

### Built-in Actions (Complete List)

`fetch:template`, `fetch:plain`, `fetch:file`, `fetch:archive`, `catalog:register`, `catalog:write`, `catalog:fetch`, `publish:github`, `publish:gitlab`, `publish:bitbucket`, `publish:azure`, `publish:gerrit`, `publish:file`, `publish:confluence`, `debug:log`, `debug:wait`, `fs:delete`, `fs:rename`, `fs:append`, `fs:write`, `notifications:send`, `roadie:backstage:create-entity`, `roadie:backstage:delete-entity`, `utils:merge`, `utils:mergePlain`, `utils:json`, `utils:stringify`, `utils:urlEncode`, `utils:replaceInFile`, `utils:parseRepoUrl`, `utils:branch`, `utils:checkout`

### Workspace Access

```yaml
steps:
  - id: template
    name: Fetch template
    action: fetch:template
    input:
      url: ./skeleton
      values:
        name: ${{ parameters.name }}
  - id: custom
    name: Custom Operation
    action: my-company:custom-action
    input:
      name: ${{ parameters.name }}
      dryRun: ${{ parameters.dryRun }}
```

The `ctx.workspacePath` contains the fetched template skeleton. Files written here persist across steps.

## Common Pitfalls

1. Missing `action` field in steps — every step needs it
2. Wrong parameter refs — `${{ parameters.name }}` not `${{ params.name }}`
3. Referencing future step outputs — only previous steps
4. Not registering custom actions via extension point
5. Forgetting `.scaffolderignore` in template directories
6. Missing final `catalog:register` step

## Verification Checklist

- [ ] Template has valid apiVersion
- [ ] Parameters use ui:* extensions appropriately
- [ ] Steps use correct action IDs
- [ ] Final step registers entity in catalog
- [ ] Custom actions registered via module
- [ ] Variables use `${{ }}` syntax correctly
