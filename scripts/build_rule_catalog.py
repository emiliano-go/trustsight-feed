"""Generate ``src/rule-catalog.generated.json``: rule id -> explanation.

The feed renders rule ids in JSON and in the references list, and each one
explains itself on hover. The explanation is built from the trusted sources
in the sibling TrustSight checkout:

* ``docs/reference/rules/*.md`` - the ``### ID: Name {#anchor}`` heading plus
  the ``- **Severity:**`` and ``- **Description:**`` lines, which are the
  published definition of every rule. The page's own heading is the rule's
  category, and the page path is the docs URL.

Nothing is hand-typed, so the feed cannot quote an explanation the tool does
not hold.

    python scripts/build_rule_catalog.py            # write if changed
    python scripts/build_rule_catalog.py --check    # exit 1 on drift

Needs the TrustSight docs: found beside this checkout (../trustsight) or
through TRUSTSIGHT_SRC.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "rule-catalog.generated.json"
DOCS_BASE = "https://docs.trustsight.org/reference/rules"

HEADING = re.compile(r"^### ([A-Z]\d{3}):\s*(.*?)\s*(?:\{#([^}]+)\})?\s*$")
H1 = re.compile(r"^#\s+(.*?)\s*$")
SEVERITY = re.compile(r"^-\s*\*\*Severity:\*\*\s*([A-Za-z]+)")
DESCRIPTION = re.compile(r"^-\s*\*\*Description:\*\*\s*(.*\S)\s*$")


def _rules_dir() -> Path:
    candidates = [
        os.environ.get("TRUSTSIGHT_SRC"),
        ROOT.parent / "trustsight" / "src",
    ]
    for candidate in candidates:
        if candidate:
            src = Path(candidate)
            repo_root = src.parent
            docs = repo_root / "docs" / "reference" / "rules"
            if docs.is_dir():
                return docs
    raise SystemExit(
        "cannot find docs/reference/rules; put the TrustSight checkout beside "
        "this one or set TRUSTSIGHT_SRC to its src/ directory"
    )


def _category_titles() -> dict[str, str]:
    """Kept for callers that want the category grouping; unused by default.

    The page heading already names the category, so the generator does not
    need to import the TrustSight package. This hook stays for a future
    re-categorisation pass.
    """
    return {}


def _parse_page(path: Path) -> list[dict]:
    lines = path.read_text().split("\n")
    page = path.stem
    page_title = ""
    for line in lines:
        m = H1.match(line)
        if m:
            page_title = m.group(1)
            break

    entries = []
    i = 0
    while i < len(lines):
        m = HEADING.match(lines[i])
        if not m:
            i += 1
            continue
        rule_id, name, anchor = m.group(1), m.group(2), m.group(3)
        severity = ""
        description = ""
        j = i + 1
        while j < len(lines) and not HEADING.match(lines[j]):
            s = SEVERITY.match(lines[j])
            d = DESCRIPTION.match(lines[j])
            if s and not severity:
                severity = s.group(1).upper()
            if d and not description:
                description = d.group(1)
            j += 1
        entries.append({
            "id": rule_id,
            "name": name,
            "severity": severity,
            "description": description,
            "page": page,
            "pageTitle": page_title,
            "anchor": anchor or rule_id.lower(),
        })
        i = j
    return entries


def build_catalog() -> str:
    docs_dir = _rules_dir()
    titles = _category_titles()

    catalog: dict[str, dict] = {}
    for path in sorted(docs_dir.glob("*.md")):
        if path.name == "index.md":
            continue
        for entry in _parse_page(path):
            key = entry["id"].lower()
            catalog[key] = {
                "id": entry["id"],
                "name": entry["name"],
                "severity": entry["severity"],
                "categoryTitle": titles.get(entry["id"], entry["pageTitle"]),
                "description": entry["description"],
                "docsUrl": f"{DOCS_BASE}/{entry['page']}/#{entry['anchor']}",
            }

    ordered = {key: catalog[key] for key in sorted(catalog)}
    return json.dumps(ordered, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed file is stale")
    args = parser.parse_args(argv)

    current = OUT.read_text() if OUT.exists() else ""
    generated = build_catalog()

    if args.check:
        if current != generated:
            print(f"{OUT.relative_to(ROOT)} is out of date. Run: python scripts/build_rule_catalog.py", file=sys.stderr)
            return 1
        count = len(json.loads(generated))
        print(f"rule catalog is current ({count} rules)")
        return 0

    if current == generated:
        print("rule catalog already current")
        return 0
    OUT.write_text(generated)
    count = len(json.loads(generated))
    print(f"wrote {OUT.relative_to(ROOT)} ({count} rules)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
