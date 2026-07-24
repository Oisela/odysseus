"""model_interaction_tools.py - agent tools for talking to other models.

Owns the model-interaction tool implementations (chat_with_model, ask_teacher,
list_models) and their handler classes, registered in ``TOOL_HANDLERS``. Part
of the tool -> registry migration (#3629): the implementations were moved here
out of ``src.ai_interaction`` so dispatch flows through the registry instead of
the elif chain / dispatch_ai_tool in tool_execution.py.

Shared helpers that still live in ``src.ai_interaction`` and are used by tools
not yet migrated (``_resolve_model``, ``AI_CHAT_TIMEOUT``) are imported lazily
inside the functions to avoid an import cycle at module load.
"""
import asyncio
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)


_TEACHER_SYSTEM_PROMPT = (
    "You are a senior AI mentor. A less capable model is stuck on a problem and asking for help. "
    "Provide clear, actionable guidance:\n"
    "1. Brief analysis of the problem\n"
    "2. Recommended approach (step by step)\n"
    "3. Key things to watch out for\n\n"
    "Be concise and practical. No preamble."
)

_DELEGATE_SYSTEM_PROMPT = (
    "You are a worker model. The lead model delegated a self-contained subtask to you. "
    "Execute it completely and return ONLY the deliverable — no preamble, no questions, "
    "no meta-commentary. If the task cannot be completed with the given context, state "
    "precisely what is missing instead of guessing."
)

# Delegation should be compact by default: it is a hand-off, not a second full
# conversation. The configured bounds are intentionally conservative and are
# surfaced in Settings so a user can trade completeness for API cost.
DEFAULT_DELEGATE_TASK_TOKEN_BUDGET = 6_000
DEFAULT_DELEGATE_RESPONSE_TOKEN_BUDGET = 4_000
_MIN_DELEGATE_TOKEN_BUDGET = 256
_MAX_DELEGATE_TOKEN_BUDGET = 32_000


def _bounded_delegate_budget(value, default: int) -> int:
    """Return a safe token budget for delegate input/output.

    Settings are user-editable JSON, so malformed values must never make a
    worker call unbounded. A zero/negative value means "use the default".
    """
    try:
        budget = int(value)
    except (TypeError, ValueError):
        budget = default
    if budget <= 0:
        budget = default
    return max(_MIN_DELEGATE_TOKEN_BUDGET, min(budget, _MAX_DELEGATE_TOKEN_BUDGET))


def _truncate_delegate_task(task: str, token_budget: int) -> tuple[str, bool]:
    """Keep a delegation hand-off within its approximate input-token budget.

    Preserve both the beginning (instructions) and end (often the requested
    output format), with an explicit marker so the worker never mistakes a
    truncated excerpt for complete source material.
    """
    max_chars = max(200, int(token_budget / 0.3))
    if len(task) <= max_chars:
        return task, False
    marker = "\n\n[... task context truncated by Odysseus token budget ...]\n\n"
    remaining = max(200, max_chars - len(marker))
    head = max(100, int(remaining * 0.7))
    tail = max(80, remaining - head)
    return task[:head].rstrip() + marker + task[-tail:].lstrip(), True


async def _call_model(model_spec: str, messages: list, *, owner: Optional[str],
                      cap: int, error_fmt: str, extra: Optional[Dict] = None,
                      max_tokens: Optional[int] = None) -> Dict:
    """Shared skeleton of every model-interaction tool: resolve the spec,
    make the LLM call, truncate the response (cap differs per tool because
    the callers budget their tool output differently), wrap errors as the
    {"error": ...} dict the agent loop expects. error_fmt gets {spec}/{err}.
    """
    from src.ai_interaction import _resolve_model, AI_CHAT_TIMEOUT
    from src.llm_core import llm_call_async

    try:
        url, model, headers = await asyncio.to_thread(_resolve_model, model_spec, owner=owner)
    except ValueError as e:
        return {"error": str(e)}

    try:
        kwargs = {"headers": headers, "timeout": AI_CHAT_TIMEOUT}
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        response = await llm_call_async(url, model, messages, **kwargs)
        if len(response) > cap:
            response = response[:cap] + "\n... (truncated)"
        result = {"model": model, "response": response}
        if extra:
            result.update(extra)
        return result
    except Exception as e:
        logger.error(f"{error_fmt.format(spec=model_spec, err=e)}")
        return {"error": error_fmt.format(spec=model_spec, err=e)}


async def chat_with_model(content: str, session_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Send a message to a specific model and return its response.

    Content format:
      Line 1: model_name (or model_name@endpoint_name)
      Line 2+: the message to send
    """
    lines = content.strip().split("\n", 1)
    if not lines or not lines[0].strip():
        return {"error": "First line must be the model name"}

    model_spec = lines[0].strip()
    message = lines[1].strip() if len(lines) > 1 else ""
    if not message:
        return {"error": "No message provided (line 2+ is the message)"}

    return await _call_model(
        model_spec,
        [{"role": "user", "content": message}],
        owner=owner, cap=10000,
        error_fmt="Failed to get response from {spec}: {err}",
    )


async def ask_teacher(content: str, session_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Ask a more capable model for help.

    Content format:
      Line 1: model_name (or 'auto')
      Line 2+: the problem description
    """
    from src.settings import get_setting

    lines = content.strip().split("\n", 1)
    model_spec = lines[0].strip() if lines else "auto"
    problem = lines[1].strip() if len(lines) > 1 else ""

    if not problem:
        return {"error": "No problem description provided"}

    if model_spec.lower() in ("auto", ""):
        model_spec = get_setting("teacher_model", "")
        if not model_spec:
            return {"error": "No teacher model configured. Specify a model name or set teacher_model in settings."}

    return await _call_model(
        model_spec,
        [
            {"role": "system", "content": _TEACHER_SYSTEM_PROMPT},
            {"role": "user", "content": f"Problem:\n{problem}"},
        ],
        owner=owner, cap=8000,
        error_fmt="Teacher call failed ({spec}): {err}",
        extra={"teacher": True},
    )


async def delegate(content: str, session_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Hand a self-contained subtask to the configured worker model.

    Content is the task text itself (optionally with inlined file excerpts) —
    unlike chat_with_model there is NO model line: the worker is fixed in
    settings (``delegate_worker_model``, "model@endpoint_name" like the
    teacher), so the lead model can delegate without knowing the fleet.
    """
    from src.settings import get_setting

    task = (content or "").strip()
    if not task:
        return {"error": "No task provided. Content = the complete, self-contained subtask (inline any needed file excerpts — the worker has no tools and cannot ask follow-ups)."}

    if not get_setting("delegate_enabled", False):
        return {"error": "Delegation is disabled. Enable it and pick a worker model in Settings → Delegate worker."}
    model_spec = get_setting("delegate_worker_model", "")
    if not model_spec:
        return {"error": "No worker model configured. Pick one in Settings → Delegate worker."}

    task_budget = _bounded_delegate_budget(
        get_setting("delegate_task_token_budget", DEFAULT_DELEGATE_TASK_TOKEN_BUDGET),
        DEFAULT_DELEGATE_TASK_TOKEN_BUDGET,
    )
    response_budget = _bounded_delegate_budget(
        get_setting("delegate_response_token_budget", DEFAULT_DELEGATE_RESPONSE_TOKEN_BUDGET),
        DEFAULT_DELEGATE_RESPONSE_TOKEN_BUDGET,
    )
    compact_task, task_truncated = _truncate_delegate_task(task, task_budget)
    result = await _call_model(
        model_spec,
        [
            {"role": "system", "content": _DELEGATE_SYSTEM_PROMPT},
            {"role": "user", "content": compact_task},
        ],
        owner=owner, cap=int(response_budget / 0.3), max_tokens=response_budget,
        error_fmt="Delegation to {spec} failed: {err}",
        extra={
            "delegated": True,
            "task_token_budget": task_budget,
            "response_token_budget": response_budget,
            "task_truncated": task_truncated,
        },
    )
    return result


async def list_models(content: str, session_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """List all available models across configured endpoints.

    Content = optional filter keyword.
    """
    import json
    import httpx
    from src.database import SessionLocal, ModelEndpoint
    from src.llm_core import _detect_provider, ANTHROPIC_MODELS
    from src.auth_helpers import owner_filter
    from src.endpoint_resolver import resolve_endpoint_runtime, build_headers, build_models_url

    keyword = content.strip().lower() if content.strip() else None

    db = SessionLocal()
    try:
        query = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
        if owner:
            query = owner_filter(query, ModelEndpoint, owner)
        endpoints = query.all()
        if not endpoints:
            return {"results": "No enabled model endpoints configured."}

        result_lines = []
        total_models = 0

        for ep in endpoints:
            try:
                base, api_key = resolve_endpoint_runtime(ep, owner=owner)
            except Exception:
                continue
            provider = _detect_provider(base)
            headers = build_headers(api_key, base)

            model_ids = []
            if provider == "anthropic":
                model_ids = list(ANTHROPIC_MODELS)
            else:
                try:
                    models_url = build_models_url(base)
                    if models_url:
                        r = httpx.get(models_url, headers=headers, timeout=5)
                        r.raise_for_status()
                        data = r.json()
                        model_ids = [m.get("id") for m in (data.get("data") or []) if m.get("id")]
                        if not model_ids:
                            model_ids = [
                                m.get("name") or m.get("model")
                                for m in (data.get("models") or [])
                                if m.get("name") or m.get("model")
                            ]
                    else:
                        model_ids = json.loads(ep.cached_models or "[]")
                except Exception:
                    model_ids = ["(endpoint offline)"]

            if keyword:
                model_ids = [m for m in model_ids if keyword in m.lower() or keyword in (ep.name or "").lower()]

            if model_ids:
                result_lines.append(f"\n**{ep.name or base}** ({provider}):")
                for mid in model_ids:
                    result_lines.append(f"  - `{mid}`")
                    total_models += 1

        if not result_lines:
            return {"results": "No models found" + (f" matching '{keyword}'" if keyword else "") + "."}

        header = f"Available models ({total_models} total):"
        return {"results": header + "\n".join(result_lines)}
    except Exception as e:
        logger.error(f"list_models failed: {e}")
        return {"error": str(e)}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Handler classes registered in TOOL_HANDLERS
# ---------------------------------------------------------------------------

class ChatWithModelTool:
    async def execute(self, content: str, ctx: dict) -> Dict:
        return await chat_with_model(content, ctx.get("session_id"), owner=ctx.get("owner"))


class AskTeacherTool:
    async def execute(self, content: str, ctx: dict) -> Dict:
        return await ask_teacher(content, ctx.get("session_id"), owner=ctx.get("owner"))


class DelegateTool:
    async def execute(self, content: str, ctx: dict) -> Dict:
        return await delegate(content, ctx.get("session_id"), owner=ctx.get("owner"))


class ListModelsTool:
    async def execute(self, content: str, ctx: dict) -> Dict:
        return await list_models(content, ctx.get("session_id"), owner=ctx.get("owner"))
