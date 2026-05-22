# Template Placeholder System

The `clean-plugin` template system uses `{{PLACEHOLDER}}` syntax. The `scaffold.py` renderer resolves these at scaffold time.

## Canonical Placeholders

| Placeholder | Input: `github-copilot` | Input: `test-e2e` | Description |
|---|---|---|---|
| `{{PLUGIN_ID}}` | `github-copilot` | `test-e2e` | Raw plugin ID (kebab-case) |
| `{{PLUGIN_ID.capitalize}}` | `GitHubCopilot` | `TestE2e` | PascalCase variant |
| `{{PLUGIN_ID.camelcase}}` | `githubCopilot` | `testE2e` | camelCase variant |
| `{{PLUGIN_NAME}}` | `GitHub Copilot Metrics` | `Test E2E` | Human-readable name (from `--name` arg) |

## Lowercase Aliases

The renderer also accepts lowercase variants:
- `{{plugin_id}}` → same as `{{PLUGIN_ID}}`
- `{{plugin_id.capitalize}}` → same as `{{PLUGIN_ID.capitalize}}`
- `{{plugin_id.camelcase}}` → same as `{{PLUGIN_ID.camelcase}}`

Aliases exist because some early template files used the lowercase form. New templates SHOULD use the uppercase canonical form.

## Conversion Algorithm

```python
def to_pascal(plugin_id: str) -> str:
    """Convert kebab-case to PascalCase: 'github-copilot' -> 'GitHubCopilot', 'test-e2e' -> 'TestE2e'"""
    parts = plugin_id.split("-")
    return "".join(p[0].upper() + p[1:] for p in parts if p)

def to_camel(plugin_id: str) -> str:
    """Convert kebab-case to camelCase: 'github-copilot' -> 'githubCopilot'"""
    pascal = to_pascal(plugin_id)
    return pascal[0].lower() + pascal[1:] if pascal else ""
```

## Pitfall: Python `.title()` Breaks on Numbers

**DO NOT use `str.title()` for PascalCase conversion.** Python's `.title()` treats every character after a non-letter as a word boundary:

```python
"test-e2e".replace("-", " ").title().replace(" ", "")
# → "TestE2E"   ← WRONG: "2e" becomes "2E"

"test-e2e".split("-") → ["test", "e2e"]
"".join(p[0].upper() + p[1:] for p in ["test", "e2e"])
# → "TestE2e"   ← CORRECT
```

This is the SINGLE most common rendering bug. Always use the split-join approach, never `.title()`.

## Usage in Templates

```typescript
// ApiRef name — uses camelcase to form a JS identifier
export const {{PLUGIN_ID.camelcase}}ApiRef = createApiRef<{{PLUGIN_ID.capitalize}}Api>({...});

// Class name — uses PascalCase
export class Default{{PLUGIN_ID.capitalize}}Client implements {{PLUGIN_ID.capitalize}}Api {...}

// Plugin ID — raw kebab-case for discovery
export const pluginId = '{{PLUGIN_ID}}';

// Human name — for UI labels
title: '{{PLUGIN_NAME}}'
```
