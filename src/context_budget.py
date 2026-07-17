"""Adaptive input-token budget for the agent loop (#1170).

The agent soft-trims its input context to ``agent_input_token_budget`` (default
6000). The old computation was ``min(context_length or budget, budget)``, which
made the 6000 default a hard ceiling for *every* model — so a 128K or 1M context
model was silently capped at 6000 input tokens even though it can hold far more.

This derives the effective budget from the model's discovered context window when
the user has NOT set an explicit budget, while still honouring an explicit setting
exactly (clamped to the window). Pure and side-effect free so it is unit-testable.
"""

# Generous ceiling so long-context models are unblocked without sending a
# pathologically large prompt every agent turn. Tunable; chosen to fully cover
# 128K models and give 1M models a large but bounded budget.
DEFAULT_HARD_MAX = 200_000
DEFAULT_BUDGET = 6000
DEFAULT_HEADROOM = 0.85


def _int_or_zero(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def compute_input_token_budget(
    configured: int,
    context_length: int,
    explicit: bool,
    *,
    default: int = DEFAULT_BUDGET,
    headroom: float = DEFAULT_HEADROOM,
    hard_max: int = DEFAULT_HARD_MAX,
) -> int:
    """Return the effective soft input-token budget.

    Args:
        configured: the value read from settings (may be the default).
        context_length: the model's discovered context window. Pass 0 when the
            window is unknown / only a bare fallback — auto-scaling then stays
            conservative instead of trusting an unproven window (review on #4122).
        explicit: True if the user set a NON-default budget. The default value is
            the "auto" sentinel (scale to the window); any other value is an
            explicit cap. (A deliberately-chosen default can't be distinguished
            from a materialized default by value, so the default reads as auto.)

    Rules:
        - Explicit user budget is honoured exactly, only clamped to the model's
          window when that window is known (the user's deliberate choice wins;
          ``hard_max`` is an auto-budget ceiling only — see #1230).
        - Otherwise (auto), scale to ``headroom`` of the context window, capped at
          ``hard_max`` — so long-context models use their capacity.
        - When the window is unknown (context_length <= 0), use the conservative
          ``default`` budget and do NOT scale off the fallback.
    """
    configured = _int_or_zero(configured)
    context_length = _int_or_zero(context_length)

    if explicit and configured > 0:
        return min(configured, context_length) if context_length > 0 else configured

    if context_length > 0:
        scaled = int(context_length * headroom)
        return max(1, min(scaled, hard_max))

    return configured if configured > 0 else default


def resolve_agent_input_budget(endpoint_url: str, model: str, context_length: int = 0,
                               *, get_setting=None) -> int:
    """Effective soft input-token budget for an agent turn (0 = budget disabled).

    Single source of truth for the settings + window-probe dance so the trim
    step (agent_loop) and the compaction trigger (chat_helpers) key off the
    SAME number — compaction firing at the model window while the trim cuts
    at a much smaller budget silently front-drops history instead of
    summarizing it (the v3.5 'Orientierungsverlust' bug).

    `get_setting` is injectable for tests; default is src.settings.get_setting.
    """
    if get_setting is None:
        from src.settings import get_setting as _gs
        get_setting = _gs
    try:
        soft = int(get_setting("agent_input_token_budget", DEFAULT_BUDGET) or 0)
    except (TypeError, ValueError):
        soft = DEFAULT_BUDGET
    if soft <= 0:
        return 0
    try:
        hard_max = int(get_setting("agent_input_token_hard_max", DEFAULT_HARD_MAX) or DEFAULT_HARD_MAX)
    except (TypeError, ValueError):
        hard_max = DEFAULT_HARD_MAX
    if hard_max <= 0:
        hard_max = DEFAULT_HARD_MAX
    from src.model_context import budget_context_for_model
    ctx = budget_context_for_model(endpoint_url, model, fallback=context_length)
    return compute_input_token_budget(
        soft, ctx, budget_is_explicit(soft), hard_max=hard_max,
    )


def budget_is_explicit(configured: int, *, default: int = DEFAULT_BUDGET) -> bool:
    """Whether a configured agent_input_token_budget is a deliberate explicit cap.

    The default value is the "auto" sentinel (scale to the model's window), so only
    a NON-default positive value counts as explicit. This keys off the VALUE, not
    settings *presence* — the settings-save path materializes every default into
    settings.json, so a persisted default must still read as auto (the regression
    #4121 / #1230 are about). Centralised here so the materialized-default contract
    is unit-testable and can't silently regress to a presence check.
    """
    configured = int(configured or 0)
    return configured > 0 and configured != default
