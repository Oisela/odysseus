"""Mobile breakpoints for Pomodoro, the Settings visibility list, and the
Project files panel.

Alessio, v4.2 (2026-07-31): "Dann alles anpassen auf Mobile, da dort lieber
simpler und einfacher zu bedienen." A pre-analysis found that these three
areas had ZERO `@media` rules of their own — on a phone the Pomodoro
settings/manual-add grids stayed two columns, and buttons/rows across all
three areas sat well under a comfortable thumb-tap height.

The fix is CSS-only (style.css is the only file this task may touch — all
JS and index.html are owned by parallel work). Two rules this file enforces
beyond "the areas now have mobile rules":

  1. No NEW breakpoint value. style.css already uses `max-width: 768px` as
     its dominant phone breakpoint (used ~130+ times elsewhere, including
     the touch-target bump for .export-dropdown-item). Introducing a
     fourth-ish value here would make the file more inconsistent, not less
     — so every new rule reuses 768px, and the set of distinct `@media`
     breakpoint conditions in the file must not grow.
  2. Real touch targets. Alessio's rule: anything tapped with a thumb needs
     at least 40px of height on mobile.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLE_CSS = (ROOT / "static" / "style.css").read_text(encoding="utf-8")

# The exact breakpoint conditions style.css already used before this change
# (from a `grep -n "@media" static/style.css` pass taken while investigating
# the fix). Anything not in this set would be a brand-new condition — this
# task was explicitly told to reuse existing values, not add a new one.
KNOWN_BREAKPOINT_CONDITIONS = {
    "(max-width: 768px)", "(max-width:768px)",
    "(max-width: 820px)", "(max-width:820px)",
    "(max-width: 700px)",
    "(max-width: 640px)",
    "(max-width: 620px)",  # @container settings-modal, not a viewport @media
    "(max-width: 600px)",
    "(max-width: 540px)",
    "(max-width: 520px)",
    "(max-width: 480px)",
    "(max-width: 460px)",
    "(max-width: 900px)",
    "(max-width: 1050px)",
    "(max-width: 720px)",  # @container docpane
    "(min-width: 769px)", "(min-width:769px)",
    "(min-width: 720px)",
    "(min-width: 821px)",
    "(min-width: 700px)",
    "(max-height: 650px)",
    "(max-height: 500px)",
    "(max-height: 380px)",
    "(hover: none)",
    "(hover: hover)",
    "(hover: none) and (pointer: coarse)",
    "(hover: none) and (pointer: coarse), (max-width: 768px)",
    "(hover: hover) and (pointer: fine)",
    "(prefers-reduced-motion: reduce)",
    "(prefers-color-scheme: light)",
    "print",
}


def _media_conditions(css: str) -> set:
    """Every distinct condition following a real `@media` keyword in the
    file. Comments are stripped first — the file has prose like "the
    @media (hover:none) block was being overridden…" inside /* */ comments,
    and a naive scan would misread that as an actual media rule."""
    without_comments = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return {
        match.group(1).strip()
        for match in re.finditer(r"@media\s+([^{]+?)\s*\{", without_comments)
    }


def test_no_new_media_breakpoint_value_introduced():
    """The mobile fix must reuse existing breakpoints, not invent a new one.

    A brand-new max-width/min-width number here would leave the stylesheet
    with yet another magic value to keep track of — the task was explicit
    that this makes the file worse, not better.
    """
    found = _media_conditions(STYLE_CSS)
    unexpected = found - KNOWN_BREAKPOINT_CONDITIONS
    assert not unexpected, (
        f"New @media condition(s) introduced that weren't already in the "
        f"file before this fix: {unexpected}"
    )


def test_media_breakpoint_count_did_not_shrink_unexpectedly():
    """Sanity check on the counting itself: the file must still have at
    least as many @media blocks as before three new ones were added for
    this fix (177 going in — see the grep pass in the task notes)."""
    assert STYLE_CSS.count("@media") >= 177 + 3


def _section(start_marker: str, end_marker: str) -> str:
    """Text between two literal markers, to scope assertions to just the
    block this fix added (rather than matching accidentally elsewhere)."""
    after_start = STYLE_CSS.split(start_marker, 1)[1]
    return after_start.split(end_marker, 1)[0]


# ── Settings visibility list (.vis-row, "Settings > Appearance > Sidebar") ──

VIS_BLOCK = _section(".vis-hint {", "/* Settings toggle")


def test_settings_visibility_has_a_768px_mobile_rule():
    assert "@media (max-width: 768px)" in VIS_BLOCK
    assert ".vis-row" in VIS_BLOCK


def test_settings_visibility_rows_reach_40px_touch_target():
    """Each .vis-row is a <label> that already covers the whole row as its
    tap target, so bumping the row height is enough — no need to resize the
    icon or the switch (no new interaction concept introduced)."""
    mobile_block = VIS_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert "min-height: 40px" in mobile_block
    assert re.search(r"\.vis-row\s*\{[^}]*min-height:\s*40px", mobile_block)


# ── Pomodoro tool window ──────────────────────────────────────────────────

POMO_BLOCK = _section(".pomo-ntfy-row {", "/* Quote-and-Ask")


def test_pomodoro_has_a_768px_mobile_rule():
    assert "@media (max-width: 768px)" in POMO_BLOCK


def test_pomodoro_settings_and_manual_row_grids_stack_to_one_column():
    """Alessio: 'simpler und einfacher zu bedienen' on mobile. The
    Focus/Rounds/Break/Long-break settings grid and the manual-add-time row
    were both 2-column CSS grids with no mobile override — stack them to
    one column instead of a cramped side-by-side pair."""
    mobile_block = POMO_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert re.search(
        r"\.pomo-settings\s*,\s*\.pomo-manual-row\s*\{\s*grid-template-columns:\s*1fr;",
        mobile_block,
    ), "expected .pomo-settings/.pomo-manual-row to collapse to grid-template-columns: 1fr on mobile"


def test_pomodoro_primary_controls_reach_40px_touch_target():
    """Start/Pause/Reset (#pomo-controls) must hit the 40px minimum, scoped
    by ID so #pip-controls (the desktop-only Document-PiP popout) keeps its
    own smaller .pomo-pip-controls sizing untouched."""
    mobile_block = POMO_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert "#pomo-controls .pomo-btn" in mobile_block
    assert re.search(
        r"#pomo-controls \.pomo-btn,[\s\S]*?\{\s*min-height:\s*40px;",
        mobile_block,
    ), "expected #pomo-controls .pomo-btn in the min-height: 40px group"
    # Must NOT touch the PiP popout's own control sizing.
    assert ".pomo-pip-controls .pomo-btn" not in mobile_block


def test_pomodoro_inputs_and_chips_reach_40px_touch_target():
    mobile_block = POMO_BLOCK.split("@media (max-width: 768px)", 1)[1]
    for selector in (".pomo-input", ".pomo-preset-chip", ".pomo-preset-name-input", ".pomo-drink-btn"):
        assert selector in mobile_block, f"{selector} missing from the Pomodoro mobile block"


# ── Project files panel (#project-panel, projects.js) ──────────────────────

PROJECT_PANEL_BLOCK = _section(".workspace-note {", "/* Real-time Diagnostics")


def test_project_panel_has_a_768px_mobile_rule():
    assert "#project-panel" in PROJECT_PANEL_BLOCK
    assert "@media (max-width: 768px)" in PROJECT_PANEL_BLOCK


def test_project_panel_save_upload_reach_40px_touch_target():
    """#pp-save / #pp-upload-btn are bare .confirm-btn (not wrapped in
    .styled-confirm-box) — outside that wrapper .confirm-btn never got a
    mobile touch-target bump, only a small padding tweak. Scoped to
    #project-panel so unrelated .confirm-btn usages elsewhere (dialogs,
    other modals) stay exactly as they were."""
    mobile_block = PROJECT_PANEL_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert re.search(
        r"#project-panel \.confirm-btn\s*\{\s*min-height:\s*40px;",
        mobile_block,
    ), "expected #project-panel .confirm-btn { min-height: 40px; ... }"


def test_project_panel_filename_link_can_shrink_to_ellipsis():
    """The file-row link has overflow:hidden/text-overflow:ellipsis inline
    but no min-width:0, so as a flex item it can't shrink below its content
    width — a long filename pushes the row wider than the sheet instead of
    eliding. min-width:0 is additive (not set inline anywhere), so it
    doesn't fight the inline overflow/ellipsis/white-space rules."""
    mobile_block = PROJECT_PANEL_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert re.search(
        r"#project-panel \.workspace-row a\s*\{\s*min-width:\s*0;",
        mobile_block,
    ), "expected #project-panel .workspace-row a { min-width: 0; }"


def test_project_panel_delete_link_deliberately_left_untouched():
    """Per-file delete is destructive — it is not blown up to a 40px tap
    target on purpose (avoids an easy fat-finger delete). Guards against a
    future edit silently over-applying the touch-target bump to it."""
    mobile_block = PROJECT_PANEL_BLOCK.split("@media (max-width: 768px)", 1)[1]
    assert "data-del" not in mobile_block


# ── Whole-file integrity ────────────────────────────────────────────────


def test_style_css_brace_balance():
    """The file is huge (40k+ lines) — an unbalanced edit silently kills
    every rule after the mistake. Guard the whole file, not just our diff."""
    opens = STYLE_CSS.count("{")
    closes = STYLE_CSS.count("}")
    assert opens == closes, (
        f"style.css brace mismatch: {opens} '{{' vs {closes} '}}' — "
        "everything after the imbalance is silently dead CSS"
    )
