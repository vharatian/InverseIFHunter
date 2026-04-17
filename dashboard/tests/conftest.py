import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_DASHBOARD = _HERE.parent
_REPO_ROOT = _DASHBOARD.parent

for p in (_REPO_ROOT, _DASHBOARD):
    s = str(p)
    if s not in sys.path:
        sys.path.insert(0, s)

os.environ.setdefault("ADMIN_PASSWORD", "test-pw")
os.environ.setdefault("SESSION_SECRET", "test-secret")
