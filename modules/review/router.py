"""
Combined reviewer router — aggregates all reviewer-app routes
for mounting in the main FastAPI app.

The reviewer-app has its own ``services``, ``config``, and ``api`` packages
that collide with the main app's namespaces.  We temporarily swap
``sys.modules`` entries so the reviewer-app code resolves its own packages,
then restore the main app's originals.  Because Python binds names at import
time, the reviewer-app route modules keep working correctly afterward.
"""
import sys
import os

from fastapi import APIRouter

_reviewer_app_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "reviewer-app",
)
_agentic_root = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)

_CONFLICTING_PREFIXES = ("services", "config", "api")


def _matches(mod_name: str) -> bool:
    return any(
        mod_name == pfx or mod_name.startswith(pfx + ".")
        for pfx in _CONFLICTING_PREFIXES
    )


# 1. Save & remove main-app modules that clash with reviewer-app packages.
_saved_modules: dict[str, object] = {}
for _mod_name in list(sys.modules):
    if _matches(_mod_name):
        _saved_modules[_mod_name] = sys.modules.pop(_mod_name)

# 2. Prepend reviewer-app to sys.path so its packages are found first.
_old_path = sys.path[:]
sys.path.insert(0, _reviewer_app_dir)
if _agentic_root not in sys.path:
    sys.path.insert(1, _agentic_root)

try:
    # 3. Import all reviewer-app route modules (they pull in reviewer-app
    #    services/config/api as side effects).
    from api.routes.health import router as health_router
    from api.routes.queue import router as queue_router
    from api.routes.task import router as task_router
    from api.routes.comments import router as comments_router
    from api.routes.edit import router as edit_router
    from api.routes.agent_routes import router as agent_router
    from api.routes.audit_routes import router as audit_router
    from api.routes.review_actions import router as review_actions_router
    from api.routes.notifications import router as notifications_router
    from api.routes.colab import router as colab_router
    from api.routes.presence import router as presence_router
    from api.routes.notebook_preview import router as notebook_preview_router
    from api.routes.session_lookup import router as session_lookup_router
    from api.routes.council import router as council_router
finally:
    # 4. Restore sys.path and main-app modules so the rest of python-core
    #    is unaffected.  Reviewer-app modules keep their own references.
    sys.path[:] = _old_path
    # Keep reviewer-app entries (routes need them at runtime) but also
    # restore main-app entries under their original names.
    _reviewer_modules: dict[str, object] = {}
    for _mod_name in list(sys.modules):
        if _matches(_mod_name):
            _reviewer_modules[_mod_name] = sys.modules[_mod_name]
    sys.modules.update(_saved_modules)
    # Stash reviewer-app modules under a "reviewer_app." prefix so they
    # remain reachable if anything does a late import.
    for _mod_name, _mod in _reviewer_modules.items():
        sys.modules[f"reviewer_app.{_mod_name}"] = _mod


reviewer_router = APIRouter()

reviewer_router.include_router(health_router)
reviewer_router.include_router(queue_router)
reviewer_router.include_router(task_router)
reviewer_router.include_router(comments_router)
reviewer_router.include_router(edit_router)
reviewer_router.include_router(agent_router)
reviewer_router.include_router(audit_router)
reviewer_router.include_router(review_actions_router)
reviewer_router.include_router(notifications_router)
reviewer_router.include_router(colab_router)
reviewer_router.include_router(presence_router)
reviewer_router.include_router(notebook_preview_router)
reviewer_router.include_router(session_lookup_router)
reviewer_router.include_router(council_router)
