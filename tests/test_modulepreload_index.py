"""index.html must modulepreload the full eager ES-module graph.

Why: the app ships ~90k lines of unbundled ES modules. Without preload
hints the browser discovers imports in waves (fetch chat.js -> parse ->
discover its imports -> fetch those -> ...); over a tailnet/DERP link
every wave costs a round trip. One <link rel="modulepreload"> per module
lets the browser fetch/revalidate the WHOLE graph in parallel at HTML
parse time. This test recomputes the static import closure from the
script tags so the hint list can't silently drift when modules are added
or re-wired (same failure mode the sw.js PRECACHE comment warns about).

Regenerate the block after changing imports:
  python -c "from tests.test_modulepreload_index import preload_link_block; print(preload_link_block())"
"""
import os
import re

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")
INDEX_HTML = os.path.join(STATIC_DIR, "index.html")

# Static import forms only — dynamic import(...) is lazy on purpose and
# must NOT be preloaded.
_IMPORT_RE = re.compile(
    r"(?:^|\n)\s*import\s+(?:[\w$*{},\s]+?from\s+)?['\"]([^'\"]+)['\"]"
)
_REEXPORT_RE = re.compile(
    r"(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})\s*from\s+['\"]([^'\"]+)['\"]"
)
_MODULE_TAG_RE = re.compile(
    r"<script\s+type=\"module\"\s+src=\"(/static/[^\"]+)\""
)
_PRELOAD_RE = re.compile(
    r"<link\s+rel=\"modulepreload\"\s+href=\"([^\"]+)\""
)


def _url_to_path(url: str) -> str:
    return os.path.normpath(os.path.join(STATIC_DIR, url.split("?")[0][len("/static/"):]))


def _path_to_url(path: str) -> str:
    rel = os.path.relpath(path, STATIC_DIR).replace(os.sep, "/")
    return f"/static/{rel}"


def _static_import_specs(js_source: str) -> list:
    return _IMPORT_RE.findall(js_source) + _REEXPORT_RE.findall(js_source)


def compute_module_graph() -> set:
    """Exact request URLs of every module statically reachable from index.html.

    Preload URLs must byte-match what the browser requests: root script tags
    keep their ?v= query verbatim, import-discovered modules use the bare
    URL. A module reached both ways (e.g. a versioned root that others
    import bare) is genuinely fetched twice today and gets both URLs.
    """
    with open(INDEX_HTML, encoding="utf-8") as fh:
        html = fh.read()
    root_urls = _MODULE_TAG_RE.findall(html)
    urls: set = {u for u in root_urls if os.path.isfile(_url_to_path(u))}
    seen_paths: set = set()
    stack = [_url_to_path(u) for u in root_urls]
    while stack:
        path = stack.pop()
        if path in seen_paths or not os.path.isfile(path):
            continue
        seen_paths.add(path)
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        for spec in _static_import_specs(src):
            if spec.startswith("."):
                child = os.path.normpath(os.path.join(os.path.dirname(path), spec))
            elif spec.startswith("/static/"):
                child = _url_to_path(spec)
            else:
                continue  # bare/external specifiers: nothing to preload locally
            if os.path.isfile(child):
                urls.add(_path_to_url(child))
                stack.append(child)
    return urls


def preload_link_block() -> str:
    lines = [
        f'  <link rel="modulepreload" href="{u}">'
        for u in sorted(compute_module_graph())
    ]
    return "\n".join(lines)


def test_modulepreload_covers_eager_module_graph():
    with open(INDEX_HTML, encoding="utf-8") as fh:
        html = fh.read()
    declared = set(_PRELOAD_RE.findall(html))
    expected = compute_module_graph()
    missing = sorted(expected - declared)
    stale = sorted(declared - expected)
    assert not missing and not stale, (
        "modulepreload links in index.html are out of sync with the static "
        f"import graph.\nMissing: {missing}\nStale: {stale}\n"
        "Regenerate: python -c \"from tests.test_modulepreload_index import "
        "preload_link_block; print(preload_link_block())\""
    )


def test_module_graph_is_nontrivial():
    # Guard against the walker silently matching nothing (regex rot would
    # otherwise make the sync test vacuously green with zero links).
    assert len(compute_module_graph()) > 30
