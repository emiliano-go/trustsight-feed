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
BULLET = re.compile(r"^-\s*\*\*([A-Za-z ]+):\*\*\s*(.*\S)?\s*$")

# Rule ids the tool emits that have no published docs heading: the weighted
# novelty signal, the source-provenance bucket and the coverage gap.  The feed
# renders them in rule lists, so without an entry they read as "not in the
# catalog".  The text is the tool's own vocabulary (scoring.py), stated here as
# the one deliberate exception to "nothing is hand-typed": these are not
# published rules, so there is no page to quote.
SYNTHETIC = {
    "NOVELTY": {
        "id": "NOVELTY",
        "name": "Novelty Signal",
        "severity": "HIGH",
        "categoryTitle": "Novelty",
        "description": (
            "A source URL or maintainer this package has never been seen with "
            "before (or that the whole seed has never seen). The weight is "
            "scaled by how much history the local database holds, so a cold "
            "database trusts the signal less. It is context, not a verdict."
        ),
    },
    "SOURCE_BUCKET": {
        "id": "SOURCE_BUCKET",
        "name": "Source Provenance",
        "severity": "MEDIUM",
        "categoryTitle": "Provenance",
        "description": (
            "A source URL was classified into a trust bucket (trusted forge, "
            "official, raw hosting, unknown or homograph). Only the least "
            "trusted added URL contributes, and the contribution is a property "
            "of the source list, not of each URL in it."
        ),
    },
    "COVERAGE": {
        "id": "COVERAGE",
        "name": "Coverage Gap",
        "severity": "INFO",
        "categoryTitle": "Coverage",
        "description": (
            "Something in the change could not be examined (a truncated diff, "
            "an unread file, a walk cut short). A gap never moves the score, "
            "but it forbids a clean verdict. The gap's own name is on the "
            "finding."
        ),
    },
    # The P-series (declared practice) is weight 0 by design and has no
    # per-rule heading in the docs, but every analysis emits it, so it needs a
    # catalog entry to render. Text is drawn from the rules reference
    # (nature.md) and scoring.py's DECLARED_REASONS.
    "P001": {
        "id": "P001", "name": "Checksums Declared", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "The recipe declares checksums for every non-VCS source. Reported, never credited: a claim an attacker can assert for free must not move the score.",
    },
    "P002": {
        "id": "P002", "name": "validpgpkeys Declared", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "The recipe declares validpgpkeys. TrustSight does not verify the keys sign anything; it reports that the recipe claims them.",
    },
    "P003": {
        "id": "P003", "name": "Signature Source", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "A signature source accompanies a source and PGP keys are declared. The signature is declared, not verified by TrustSight.",
    },
    "P005": {
        "id": "P005", "name": "Commit Pinned", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "A source is pinned to a full commit hash. Reported as a declared fact; TrustSight does not fetch the commit to confirm what it holds.",
    },
    "P006": {
        "id": "P006", "name": "Tag Pinned", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "A source is pinned to a tag (tags can be repointed; commit pins cannot). Weaker than a commit pin and reported as such.",
    },
    "P007": {
        "id": "P007", "name": "Trusted Forge", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "A source is hosted on a trusted forge over HTTPS. A declared property of the URL, not a verification of the content.",
    },
    "P008": {
        "id": "P008", "name": "No Commit Pin", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "A source tracks a branch or unpinned ref; upstream decides at build time what this compiles and runs. Stated so its absence is not mistaken for a pin.",
    },
    "P009": {
        "id": "P009", "name": "Prebuilt Deliverable", "severity": "INFO",
        "categoryTitle": "Declared Practice",
        "description": "The recipe declares a prebuilt deliverable (-bin/-appimage/-wine name or a prebuilt-artifact source). M001 pairs the declaration against a committed binary the recipe did not declare.",
    },
}


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


def _section_bullets_and_prose(lines: list[str], start: int, end: int) -> tuple[dict, list[str]]:
    """A section's bullets (with their wrapped continuation lines) and prose.

    The docs state some rules as a one-line ``Description``, others as a
    ``Condition`` that wraps across lines, and often an explanatory paragraph
    below. Reading only the first line truncated the explanation (a rule read
    "A package whose name ends in -bin declares an added" and stopped), so a
    bullet absorbs its continuation lines and the prose paragraphs are kept
    whole.
    """
    bullets: dict[str, str] = {}
    prose: list[str] = []
    key: str | None = None
    parts: list[str] = []
    block: list[str] = []

    def flush_bullet() -> None:
        nonlocal key, parts
        if key is not None:
            bullets.setdefault(key, " ".join(parts).strip())
        key, parts = None, []

    def flush_prose() -> None:
        if block:
            prose.append(" ".join(block))
            block.clear()

    for i in range(start, end):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            flush_bullet()
            flush_prose()
            continue
        m = BULLET.match(line)
        if m:
            flush_bullet()
            flush_prose()
            key = m.group(1).strip().lower()
            parts = [m.group(2).strip()] if m.group(2) else []
        elif key is not None:
            parts.append(stripped)
        else:
            block.append(stripped)
    flush_bullet()
    flush_prose()
    return bullets, prose


META_LINE = re.compile(r"^\*\*([A-Z]+)\*\*.*(?:weight|category)")
FIRE_RATE = re.compile(r"^(?:Fire rate|Measured)[:\s]")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)


def _without_comments(text: str) -> str:
    """Docs use HTML comments as markers, not prose; they must not reach the feed."""
    return " ".join(HTML_COMMENT.sub("", text or "").split())


def _looks_like_meta(text: str) -> bool:
    """A `**SEVERITY** (weight N) · category x` or `Fire rate: ...` line."""
    return bool(META_LINE.match(text)) or bool(FIRE_RATE.match(text))


def _parse_page(path: Path) -> list[dict]:
    lines = path.read_text().split("\n")
    page = path.stem
    page_title = ""
    for line in lines:
        m = H1.match(line)
        if m:
            page_title = m.group(1)
            break

    heads = [i for i, line in enumerate(lines) if HEADING.match(line)]
    entries = []
    for n, index in enumerate(heads):
        m = HEADING.match(lines[index])
        rule_id, name, anchor = m.group(1), m.group(2), m.group(3)
        end = heads[n + 1] if n + 1 < len(heads) else len(lines)
        bullets, prose = _section_bullets_and_prose(lines, index + 1, end)
        severity = (bullets.get("severity") or "").split(" ")[0].upper()
        explicit = _without_comments(bullets.get("description") or "")
        condition = _without_comments(bullets.get("condition") or "")
        # Some pages (crossfire, sabotage) open with `**SEVERITY** ... category`
        # instead of a Severity bullet. That line is metadata, not the
        # explanation; take its severity and use the paragraph after it.
        paragraph = ""
        for block in prose:
            if _looks_like_meta(block):
                if not severity:
                    m2 = META_LINE.match(block)
                    severity = m2.group(1) if m2 else severity
                continue
            clean = _without_comments(block)
            if clean:
                paragraph = clean
                break
        entries.append({
            "id": rule_id,
            "name": name,
            "severity": severity,
            # An explicit Description wins; otherwise the explanatory
            # paragraph, and only then the bare Condition.
            "description": explicit or paragraph or condition,
            "page": page,
            "pageTitle": page_title,
            "anchor": anchor or rule_id.lower(),
        })
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

    # Tool-emitted pseudo-rules have no published page; give them an entry so
    # a NOVELTY or SOURCE_BUCKET chip explains itself instead of reading as
    # "not in the catalog".  A published rule of the same id always wins.
    for key, entry in SYNTHETIC.items():
        catalog.setdefault(key.lower(), {
            "id": entry["id"],
            "name": entry["name"],
            "severity": entry["severity"],
            "categoryTitle": entry["categoryTitle"],
            "description": entry["description"],
            "docsUrl": f"{DOCS_BASE}/",
        })

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
