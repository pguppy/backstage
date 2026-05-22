#!/usr/bin/env python3
"""
Clean Backstage Plugin Scaffolder.

Replaces `yarn new` entirely. Produces a 5-package feature scaffold
with zero demo code, zero cleanup needed, and all package.json fields
correct from the start.

Usage:
    python3 scaffold.py --id github-copilot --name "GitHub Copilot Metrics" --target /path/to/backstage

What it produces:
    plugins/<id>-common/       common-library (types, permissions, openapi.yaml)
    plugins/<id>-node/         node-library   (types, extension points)
    plugins/<id>-backend/      backend-plugin (router, plugin, generated stub)
    plugins/<id>-react/        web-library    (ApiRef, hooks, testUtils, generated stub)
    plugins/<id>/              frontend-plugin (plugin, DefaultClient, routes)
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import sys

TEMPLATE_DIR = pathlib.Path(__file__).resolve().parent

PACKAGE_MAP = {
    "common-library": "-common",
    "node-library": "-node",
    "backend-plugin": "-backend",
    "web-library": "-react",
    "frontend-plugin": "",
}


def to_pascal(plugin_id: str) -> str:
    """Convert kebab-case to PascalCase: 'github-copilot' -> 'GitHubCopilot', 'test-e2e' -> 'TestE2e'"""
    parts = plugin_id.split("-")
    return "".join(p[0].upper() + p[1:] for p in parts if p)


def to_camel(plugin_id: str) -> str:
    """Convert kebab-case to camelCase: 'github-copilot' -> 'githubCopilot'"""
    pascal = to_pascal(plugin_id)
    return pascal[0].lower() + pascal[1:] if pascal else ""


def render(content: str, plugin_id: str, plugin_name: str) -> str:
    """Replace all placeholder variants."""
    pascal = to_pascal(plugin_id)
    camel = to_camel(plugin_id)

    replacements = {
        # Canonical (uppercase)
        "{{PLUGIN_ID}}": plugin_id,
        "{{PLUGIN_NAME}}": plugin_name,
        "{{PLUGIN_ID.capitalize}}": pascal,
        "{{PLUGIN_ID.capitalize()}}": pascal,
        "{{PLUGIN_ID.camelcase}}": camel,
        "{{PLUGIN_ID.camelcase()}}": camel,
        "{{PLUGIN_NAME.capitalize}}": plugin_name,
        "{{PLUGIN_NAME.capitalize()}}": plugin_name,
        # Legacy lowercase aliases (some templates use these)
        "{{plugin_id}}": plugin_id,
        "{{plugin_id.capitalize}}": pascal,
        "{{plugin_id.capitalize()}}": pascal,
        "{{plugin_id.camelcase}}": camel,
        "{{plugin_id.camelcase()}}": camel,
    }
    result = content
    for old, new in replacements.items():
        result = result.replace(old, new)
    return result


def scaffold(plugin_id: str, plugin_name: str, target: pathlib.Path) -> None:
    plugins_dir = target / "plugins"

    if not plugins_dir.exists():
        print(f"Error: {plugins_dir} does not exist. Is {target} a Backstage repo?")
        sys.exit(1)

    for template_pkg, suffix in PACKAGE_MAP.items():
        pkg_name = f"{plugin_id}{suffix}"
        dest_dir = plugins_dir / pkg_name
        src_dir = TEMPLATE_DIR / template_pkg

        if not src_dir.exists():
            print(f"  SKIP {pkg_name}: template dir {template_pkg} not found")
            continue

        print(f"  Creating {pkg_name}/ ...")

        for root, dirs, files in os.walk(src_dir):
            rel = pathlib.Path(root).relative_to(src_dir)
            dest_root = dest_dir / rel
            dest_root.mkdir(parents=True, exist_ok=True)

            for filename in files:
                src_path = pathlib.Path(root) / filename
                dest_path = dest_root / filename

                with open(src_path) as f:
                    content = f.read()

                rendered = render(content, plugin_id, plugin_name)

                with open(dest_path, "w") as f:
                    f.write(rendered)

    print(f"\n  Done. Scaffolded {len(PACKAGE_MAP)} packages into {plugins_dir}/")
    print(f"  Packages: {', '.join(f'{plugin_id}{s}' for s in PACKAGE_MAP.values())}")


def main():
    parser = argparse.ArgumentParser(description="Scaffold a clean Backstage plugin feature")
    parser.add_argument("--id", required=True, help="Plugin ID (e.g. github-copilot)")
    parser.add_argument("--name", required=True, help="Human-readable name (e.g. 'GitHub Copilot Metrics')")
    parser.add_argument("--target", required=True, help="Path to Backstage repo root")
    args = parser.parse_args()

    target = pathlib.Path(args.target).resolve()
    scaffold(args.id, args.name, target)


if __name__ == "__main__":
    main()
