"""_sniff_doc_language must recognize LaTeX sources so a pasted/AI-created
.tex document gets language='latex' (which enables the Compile toggle in the
editor) instead of defaulting to markdown."""
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from src.agent_tools.document_tools import _sniff_doc_language


def test_documentclass_detected_as_latex():
    src = "\\documentclass{article}\n\\begin{document}\nHallo\n\\end{document}\n"
    assert _sniff_doc_language(src) == "latex"


def test_begin_document_without_class_detected_as_latex():
    src = "% preamble split elsewhere\n\\begin{document}\nE=mc^2\n\\end{document}"
    assert _sniff_doc_language(src) == "latex"


def test_prose_mentioning_latex_stays_markdown():
    assert _sniff_doc_language("Notes about LaTeX and \\alpha symbols.") == "markdown"
