"""Notebook Parser — composes core parsing + export mixin."""
from services.notebook_export import NotebookExportMixin
from services.notebook_parser_core import NotebookParserCore


class NotebookParser(NotebookExportMixin, NotebookParserCore):
    """Parser for Colab/Jupyter notebook files."""


notebook_parser = NotebookParser()
