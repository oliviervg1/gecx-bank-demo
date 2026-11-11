#!/usr/bin/env python3
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Read-only Gemini Composite v2 bundle auditor for Cloudbank CXAS workspaces.

Checks CX Agent Studio (GECX) / CXAS bundles against Composite v2 voice rules:
- ``CV201``: ``modelSettings.model == "gemini-composite-v2"`` in ``app.json`` and
  sub-agents inherit without overriding to a legacy model.
- ``CV203``: Zero Director's Notes in ``app.json`` or prompts, and prebuilt
  ``synthesizeSpeechConfigs.<locale>.instruction`` is ``<= 25`` words.
- ``CV204``: Chirp 3 HD voice parity across declared locales and multilingual support.
- ``CV205``: Custom cloned voice ``gs://`` URI and ``NO_INSTRUCTION`` hygiene.
- ``CV210`` / ``CV212`` / ``CV213``: Zero ``[bracket]`` audio tags, zero closing
  audio tags, and every inline ``<tag>`` matches ``shared/composite_v2_tags.json``.
- ``CV216``: ``Affective_Delivery_and_Voice_Guidelines`` present in global instruction
  under ``{@startModalityVOICE}`` and referenced by all specialist agents.
- ``CV217``: Conditional ``Scope:``-guarded spoken text normalization.
- Platform linter rules ``I015`` (prohibited platform XML tags) and ``V104``
  (unregistered template variables) via ``cxas_scrapi.utils.linter``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from cxas_scrapi.utils.linter import (
    Discovery,
    LintConfig,
    LintReport,
    Severity,
    build_context,
    build_registry,
    run_rules,
)

TARGET_MODEL = "gemini-composite-v2"
SPEAKING_STYLE_WORD_LIMIT = 25
RUNTIME_NORMALIZED_LOCALES = frozenset({"fr", "fr-ca", "es", "es-us"})

CLOUDBANK_DIR = Path(__file__).resolve().parent.parent
TAGS_VOCAB_PATH = CLOUDBANK_DIR / "shared" / "composite_v2_tags.json"

STRUCTURAL_XML_TAGS = frozenset(
    {
        "role",
        "persona",
        "constraints",
        "taskflow",
        "subtask",
        "step",
        "trigger",
        "action",
        "examples",
        "instruction",
        "untrusted_web_snippet",
    }
)
DIRECTORS_NOTE_MARKERS = (
    "# audio profile",
    "# the scene",
    "# director's note",
    "<agent_voice",
    "## transcript:",
    "<voice_lock",
    "<voice_output",
)
INLINE_ANGLE_TAG_RE = re.compile(
    r"(?<![A-Za-z0-9])<(?P<slash>/?)\s*(?P<body>[A-Za-z][A-Za-z0-9_=\"'%\s.-]{0,55}?)\s*>(?![A-Za-z0-9])"
)
SQUARE_BRACKET_TAG_RE = re.compile(r"\[(?P<body>[A-Za-z][A-Za-z -]{1,35})\]")
PROSODY_TAG_RE = re.compile(r'^prosody\s+rate="\d{1,3}(?:\.\d+)?%"$', re.IGNORECASE)
CODE_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)


@dataclass(frozen=True)
class AuditFinding:
    """Single read-only Composite v2 audit finding."""

    priority: str
    code: str
    file: str
    line: int
    message: str


def load_tag_vocabulary(vocab_path: Path = TAGS_VOCAB_PATH) -> frozenset[str]:
    """Load canonical Composite v2 inline tag words from shared/composite_v2_tags.json."""
    if not vocab_path.is_file():
        raise FileNotFoundError(f"Missing Composite v2 tag vocabulary: {vocab_path}")
    payload = json.loads(vocab_path.read_text(encoding="utf-8"))
    words = payload.get("words")
    if not isinstance(words, list) or not words:
        raise ValueError(f"Invalid words array in {vocab_path}")
    return frozenset(str(w).strip().lower() for w in words if str(w).strip())


def _is_runtime_normalized_locale(locale: str) -> bool:
    low = locale.strip().lower()
    return low.startswith("en-") or low == "en" or low in RUNTIME_NORMALIZED_LOCALES


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _strip_code_fences_preserving_lines(text: str) -> str:
    """Blank out fenced tool_code/tool_outputs blocks while preserving line numbers."""
    return CODE_FENCE_RE.sub(lambda m: "\n" * m.group(0).count("\n"), text)


def _audit_app_and_agents_json(
    workspace: Path, app_cfg: dict[str, Any]
) -> list[AuditFinding]:
    """Validate CV201, CV203, CV204, and CV205 across app.json and agents/*/*.json."""
    findings: list[AuditFinding] = []
    model = str((app_cfg.get("modelSettings") or {}).get("model") or "")
    if model != TARGET_MODEL:
        findings.append(
            AuditFinding(
                "P0",
                "CV201",
                "app.json",
                1,
                f"modelSettings.model must be {TARGET_MODEL!r} (found {model!r}).",
            )
        )

    if "directorsNote" in app_cfg:
        findings.append(
            AuditFinding(
                "P0",
                "CV203",
                "app.json",
                1,
                "Remove legacy directorsNote from app.json.",
            )
        )

    lang_cfg = app_cfg.get("languageSettings") or {}
    default_locale = str(lang_cfg.get("defaultLanguageCode") or "").strip()
    supported = [
        str(loc).strip()
        for loc in (lang_cfg.get("supportedLanguageCodes") or [])
        if str(loc).strip()
    ]
    declared_locales = list(dict.fromkeys([default_locale, *supported])) if default_locale else supported
    if len(declared_locales) > 1 and not lang_cfg.get("enableMultilingualSupport"):
        findings.append(
            AuditFinding(
                "P1",
                "CV204",
                "app.json",
                1,
                "languageSettings.enableMultilingualSupport must be true when multiple locales are declared.",
            )
        )

    audio_cfg = app_cfg.get("audioProcessingConfig") or {}
    speech_cfgs = audio_cfg.get("synthesizeSpeechConfigs") or {}
    custom_samples = audio_cfg.get("customVoiceSamples") or []
    custom_names: set[str] = set()

    for sample in custom_samples:
        if not isinstance(sample, dict):
            continue
        cname = str(sample.get("name") or "").strip()
        if cname:
            custom_names.add(cname)
        voice_uri = str(sample.get("voiceSampleGcsUri") or "")
        consent_uri = str(sample.get("consentAudioGcsUri") or "")
        if not voice_uri.startswith("gs://") or not consent_uri.startswith("gs://"):
            findings.append(
                AuditFinding(
                    "P0",
                    "CV205",
                    "app.json",
                    1,
                    f"Custom voice {cname!r} must specify gs:// URIs for both voiceSampleGcsUri and consentAudioGcsUri.",
                )
            )
        if sample.get("voiceInstructionMode") != "NO_INSTRUCTION":
            findings.append(
                AuditFinding(
                    "P0",
                    "CV205",
                    "app.json",
                    1,
                    f"Custom voice {cname!r} must set voiceInstructionMode to 'NO_INSTRUCTION'.",
                )
            )
        if sample.get("voiceInstruction"):
            findings.append(
                AuditFinding(
                    "P0",
                    "CV203",
                    "app.json",
                    1,
                    f"Custom voice {cname!r} voiceInstruction must be empty.",
                )
            )
        if "previewAudioContent" in sample:
            findings.append(
                AuditFinding(
                    "P2",
                    "CV205",
                    "app.json",
                    1,
                    f"Strip transient previewAudioContent blob from custom voice {cname!r}.",
                )
            )

    for locale in declared_locales:
        scfg = speech_cfgs.get(locale)
        if not isinstance(scfg, dict):
            findings.append(
                AuditFinding(
                    "P0",
                    "CV204",
                    "app.json",
                    1,
                    f"Missing synthesizeSpeechConfigs entry for declared locale {locale!r}.",
                )
            )
            continue
        voice = str(scfg.get("voice") or "").strip()
        is_custom = voice in custom_names
        if not is_custom and f"{locale}-Chirp3-HD-" not in voice:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV204",
                    "app.json",
                    1,
                    f"Locale {locale!r} voice {voice!r} must use '{locale}-Chirp3-HD-*' or a bound customVoiceSamples name.",
                )
            )
        style_inst = str(scfg.get("instruction") or "").strip()
        if is_custom and style_inst:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV203",
                    "app.json",
                    1,
                    f"Locale {locale!r} bound to custom voice {voice!r} must keep instruction empty.",
                )
            )
        elif style_inst:
            low_inst = style_inst.lower()
            if any(marker in low_inst for marker in DIRECTORS_NOTE_MARKERS):
                findings.append(
                    AuditFinding(
                        "P0",
                        "CV203",
                        "app.json",
                        1,
                        f"Locale {locale!r} synthesizeSpeechConfigs.instruction contains a Director's Note.",
                    )
                )
            word_count = len(style_inst.split())
            if word_count > SPEAKING_STYLE_WORD_LIMIT:
                findings.append(
                    AuditFinding(
                        "P0",
                        "CV203",
                        "app.json",
                        1,
                        f"Locale {locale!r} speaking style has {word_count} words (max {SPEAKING_STYLE_WORD_LIMIT}).",
                    )
                )

    agents_dir = workspace / "agents"
    if agents_dir.is_dir():
        for agent_json in sorted(agents_dir.glob("*/*.json")):
            rel = agent_json.relative_to(workspace).as_posix()
            acfg = json.loads(agent_json.read_text(encoding="utf-8"))
            if "modelSettings" in acfg:
                agent_model = str((acfg.get("modelSettings") or {}).get("model") or "")
                if agent_model != TARGET_MODEL:
                    findings.append(
                        AuditFinding(
                            "P0",
                            "CV201",
                            rel,
                            1,
                            f"Agent overrides modelSettings.model to {agent_model!r} instead of inheriting {TARGET_MODEL!r}.",
                        )
                    )
    return findings


def _audit_instruction_file(
    rel_path: str,
    raw_text: str,
    is_global: bool,
    declared_locales: list[str],
    vocab_words: frozenset[str],
) -> list[AuditFinding]:
    """Validate prompt hygiene, inline tags, global voice block, and normalization scope."""
    findings: list[AuditFinding] = []
    low_full = raw_text.lower()

    for marker in DIRECTORS_NOTE_MARKERS:
        idx = low_full.find(marker)
        if idx != -1:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV203",
                    rel_path,
                    _line_number(raw_text, idx),
                    f"Prompt contains Director's Note / static voice preset marker {marker!r}.",
                )
            )

    if is_global:
        if 'id="Affective_Delivery_and_Voice_Guidelines"' not in raw_text:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV216",
                    rel_path,
                    1,
                    "Global instruction must include <instruction id=\"Affective_Delivery_and_Voice_Guidelines\">.",
                )
            )
        if "{@startModalityVOICE}" not in raw_text or "{@endModalityVOICE}" not in raw_text:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV216",
                    rel_path,
                    1,
                    "Global voice delivery guidelines must be wrapped in {@startModalityVOICE}..{@endModalityVOICE}.",
                )
            )
        has_unsupported_locale = any(
            not _is_runtime_normalized_locale(loc) for loc in declared_locales
        )
        has_norm_block = 'id="text normalization for speech"' in low_full
        if has_unsupported_locale and not has_norm_block:
            findings.append(
                AuditFinding(
                    "P1",
                    "CV217",
                    rel_path,
                    1,
                    "Unsupported TTS locale configured without <instruction id=\"text normalization for speech\">.",
                )
            )
        if has_norm_block and "scope:" not in low_full:
            findings.append(
                AuditFinding(
                    "P0",
                    "CV217",
                    rel_path,
                    1,
                    "Text normalization block is missing a mandatory 'Scope:' tool-argument guard.",
                )
            )
    elif "Affective_Delivery_and_Voice_Guidelines" not in raw_text:
        findings.append(
            AuditFinding(
                "P0",
                "CV216",
                rel_path,
                1,
                "Agent instruction must reference Affective_Delivery_and_Voice_Guidelines.",
            )
        )

    scannable = _strip_code_fences_preserving_lines(raw_text)

    for sq_match in SQUARE_BRACKET_TAG_RE.finditer(scannable):
        inner = sq_match.group("body").strip().lower()
        if inner in ("user", "model") or inner.startswith("diagnosis context"):
            continue
        tokens = [t for t in inner.split() if t]
        if tokens and all(t in vocab_words for t in tokens):
            findings.append(
                AuditFinding(
                    "P0",
                    "CV210",
                    rel_path,
                    _line_number(scannable, sq_match.start()),
                    f"Square-bracket audio tag '[{sq_match.group('body')}]' must use angle brackets '<...>'.",
                )
            )

    lines = scannable.splitlines()
    for match in INLINE_ANGLE_TAG_RE.finditer(scannable):
        lineno = _line_number(scannable, match.start())
        line_text = lines[lineno - 1] if 1 <= lineno <= len(lines) else ""
        is_closing = bool(match.group("slash"))
        body = match.group("body").strip()
        tag_head = body.split()[0].lower() if body else ""

        if tag_head in STRUCTURAL_XML_TAGS:
            continue

        if is_closing:
            # Allow negative rule prose explaining never to write closing tags.
            if "never write a closing tag" in line_text.lower():
                continue
            findings.append(
                AuditFinding(
                    "P0",
                    "CV213",
                    rel_path,
                    lineno,
                    f"Closing audio tag '</{body}>' is prohibited in Composite v2 prompts.",
                )
            )
            continue

        if PROSODY_TAG_RE.match(body):
            continue

        words = [w.lower() for w in body.split() if w]
        unknown = [w for w in words if w not in vocab_words]
        if unknown:
            findings.append(
                AuditFinding(
                    "P1",
                    "CV212",
                    rel_path,
                    lineno,
                    f"Inline tag '<{body}>' uses word(s) absent from shared/composite_v2_tags.json: {unknown}.",
                )
            )

    return findings


def _run_platform_rules(workspace: Path) -> list[AuditFinding]:
    """Run model-agnostic cxas-scrapi rules I015 and V104 on workspace."""
    config = LintConfig()
    discovery = Discovery(app_dir=workspace, evals_dir=CLOUDBANK_DIR / "evals")
    ctx = build_context(CLOUDBANK_DIR, config, discovery)
    reg = build_registry()
    report = LintReport()
    run_rules(
        reg,
        config,
        ctx,
        discovery,
        report,
        specific_rules={"I015", "V104"},
    )
    findings: list[AuditFinding] = []
    for item in report.results:
        prio = "P0" if item.severity == Severity.ERROR else "P1"
        findings.append(
            AuditFinding(
                priority=prio,
                code=item.rule_id,
                file=item.file or "app.json",
                line=item.line or 1,
                message=item.message,
            )
        )
    return findings


def audit_workspace(
    workspace: Path, vocab_path: Path = TAGS_VOCAB_PATH
) -> dict[str, Any]:
    """Execute read-only Composite v2 audit and return structured P0/P1/P2 summary."""
    resolved = workspace.resolve()
    app_json_path = resolved / "app.json"
    if not app_json_path.is_file():
        raise FileNotFoundError(f"No app.json found in workspace: {resolved}")

    vocab_words = load_tag_vocabulary(vocab_path)
    app_cfg = json.loads(app_json_path.read_text(encoding="utf-8"))
    lang_cfg = app_cfg.get("languageSettings") or {}
    default_loc = str(lang_cfg.get("defaultLanguageCode") or "").strip()
    supported = [str(x).strip() for x in (lang_cfg.get("supportedLanguageCodes") or []) if str(x).strip()]
    declared_locales = list(dict.fromkeys([default_loc, *supported])) if default_loc else supported

    all_findings = _audit_app_and_agents_json(resolved, app_cfg)

    global_rel = str(app_cfg.get("globalInstruction") or "global_instruction.txt")
    global_path = resolved / global_rel
    if global_path.is_file():
        all_findings.extend(
            _audit_instruction_file(
                global_rel,
                global_path.read_text(encoding="utf-8"),
                is_global=True,
                declared_locales=declared_locales,
                vocab_words=vocab_words,
            )
        )
    else:
        all_findings.append(
            AuditFinding("P0", "CV216", "app.json", 1, f"Missing {global_rel}.")
        )

    agents_dir = resolved / "agents"
    if agents_dir.is_dir():
        for inst_path in sorted(agents_dir.glob("*/instruction.txt")):
            all_findings.extend(
                _audit_instruction_file(
                    inst_path.relative_to(resolved).as_posix(),
                    inst_path.read_text(encoding="utf-8"),
                    is_global=False,
                    declared_locales=declared_locales,
                    vocab_words=vocab_words,
                )
            )

    all_findings.extend(_run_platform_rules(resolved))

    grouped: dict[str, list[dict[str, Any]]] = {"P0": [], "P1": [], "P2": []}
    for finding in all_findings:
        grouped.setdefault(finding.priority, []).append(asdict(finding))

    total = sum(len(items) for items in grouped.values())
    return {
        "workspace": str(resolved),
        "overall_status": "PASSED" if total == 0 else "FAILED",
        "total_issues": total,
        "counts": {k: len(v) for k, v in grouped.items()},
        "issues": grouped,
    }


def format_markdown_report(result: dict[str, Any]) -> str:
    """Format audit result as a concise prioritized Markdown readiness report."""
    counts = result["counts"]
    lines = [
        "# Gemini Composite v2 Voice Readiness Report",
        "",
        f"- **Status:** `{result['overall_status']}`",
        f"- **Findings:** `P0={counts['P0']}`, `P1={counts['P1']}`, `P2={counts['P2']}`",
    ]
    if result["total_issues"] == 0:
        lines.extend(["", "All Gemini Composite v2 checks passed with zero findings."])
        return "\n".join(lines)

    lines.extend(
        [
            "",
            "| Priority | Code | Location | Details |",
            "| :--- | :--- | :--- | :--- |",
        ]
    )
    for prio in ("P0", "P1", "P2"):
        for item in result["issues"].get(prio, []):
            loc = f"`{item['file']}:{item['line']}`"
            lines.append(f"| **{prio}** | `{item['code']}` | {loc} | {item['message']} |")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser for audit_agent.py."""
    parser = argparse.ArgumentParser(
        prog="audit_agent.py",
        description="Read-only Gemini Composite v2 readiness auditor for CXAS bundles.",
    )
    parser.add_argument(
        "--workspace",
        "--app-dir",
        dest="workspace",
        default="cxas_app/Cloudbank",
        help="Path to the CXAS application directory containing app.json.",
    )
    parser.add_argument(
        "--report",
        action="store_true",
        help="Print prioritized Markdown readiness report.",
    )
    parser.add_argument(
        "--json",
        "--json-output",
        dest="json_output",
        action="store_true",
        help="Print structured JSON output.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional path to write report or JSON output.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run read-only Composite v2 audit CLI and return exit code."""
    args = build_parser().parse_args(argv)
    result = audit_workspace(Path(args.workspace))
    if args.json_output:
        rendered = json.dumps(result, indent=2)
    elif args.report:
        rendered = format_markdown_report(result)
    else:
        summary_lines = [f"=== CXAS Composite v2 Audit: {result['overall_status']} ==="]
        for prio in ("P0", "P1", "P2"):
            for item in result["issues"].get(prio, []):
                summary_lines.append(
                    f"[{prio}] {item['code']} {item['file']}:{item['line']}: {item['message']}"
                )
        rendered = "\n".join(summary_lines)

    if args.output is not None:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if result["overall_status"] == "PASSED" else 1


if __name__ == "__main__":
    sys.exit(main())
