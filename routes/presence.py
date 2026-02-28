"""
Presence routes for the trainer app.

(All endpoints removed — trainer frontend does not use presence;
reviewer-app has its own presence module.)
"""
import logging

from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["presence"])
