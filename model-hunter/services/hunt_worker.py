"""
Hunt Worker — Background job processor for hunt execution.

Decouples hunt execution from HTTP/SSE connections.
Hunts are submitted as jobs to a Redis Stream (mh:hunt_jobs).
Worker loops in each container claim and process jobs.

If a container dies mid-hunt:
- The job stays unACK'd in the consumer group
- The other container's worker detects the stale job (via XPENDING)
- Re-claims it (via XCLAIM) and resumes the hunt
- Already-completed results in Redis are skipped (resumable execution)

Stream: mh:hunt_jobs
Consumer group: hunt_workers
Consumer ID: {hostname}:{pid} (unique per container process)

Usage:
    # Submit a job (from SSE endpoint)
    await submit_hunt_job(session_id)

    # Start worker (on app startup)
    asyncio.create_task(run_worker_loop())
"""
import asyncio
import os
import logging
from typing import Optional

from services.redis_session import get_redis, get_redis_blocking
from services.hunt_engine import hunt_engine

logger = logging.getLogger(__name__)

# Configuration
JOB_STREAM = "mh:hunt_jobs"
CONSUMER_GROUP = "hunt_workers"
CONSUMER_ID = f"{os.getenv('HOSTNAME', 'local')}:{os.getpid()}"
BLOCK_TIMEOUT_MS = 5000       # Poll every 5s for new jobs
STALE_CHECK_INTERVAL = 15     # Check for stale jobs every 15s
STALE_THRESHOLD_MS = 60000    # Re-claim jobs idle for >60s
MAX_STREAM_LEN = 500          # Keep last 500 jobs in stream


async def _ensure_consumer_group():
    """Create the consumer group if it doesn't exist."""
    r = await get_redis()
    try:
        await r.xgroup_create(JOB_STREAM, CONSUMER_GROUP, id="0", mkstream=True)
        logger.info(f"Created consumer group '{CONSUMER_GROUP}' on '{JOB_STREAM}'")
    except Exception as e:
        # Group already exists — that's fine
        if "BUSYGROUP" in str(e):
            pass
        else:
            logger.error(f"Error creating consumer group: {e}")


async def submit_hunt_job(session_id: str) -> str:
    """
    Submit a hunt job to the Redis Stream.
    Returns the stream entry ID.
    Called by the SSE endpoint instead of asyncio.create_task(run_hunt).
    """
    r = await get_redis()
    entry_id = await r.xadd(
        JOB_STREAM,
        {"session_id": session_id, "action": "run_hunt"},
        maxlen=MAX_STREAM_LEN,
        approximate=True
    )
    logger.info(f"Submitted hunt job for session {session_id} (job_id={entry_id})")
    return entry_id


async def run_worker_loop():
    """
    Main worker loop — runs as a background task in each container.
    Claims jobs from the Redis Stream and executes hunts.
    Also periodically checks for stale (unACK'd) jobs from dead workers.
    """
    await _ensure_consumer_group()

    logger.info(f"Hunt worker started: consumer={CONSUMER_ID}, group={CONSUMER_GROUP}")

    stale_check_counter = 0

    while True:
        try:
            # Read new jobs from the stream
            r = await get_redis_blocking()
            result = await r.xreadgroup(
                CONSUMER_GROUP,
                CONSUMER_ID,
                {JOB_STREAM: ">"},  # ">" means only new, undelivered messages
                count=1,
                block=BLOCK_TIMEOUT_MS
            )

            if result:
                for stream_name, entries in result:
                    for entry_id, fields in entries:
                        session_id = fields.get("session_id", "")
                        action = fields.get("action", "")

                        if action == "run_hunt" and session_id:
                            logger.info(f"Worker claimed job {entry_id} for session {session_id}")
                            try:
                                await hunt_engine.run_hunt(session_id)
                                logger.info(f"Worker completed job {entry_id} for session {session_id}")
                            except Exception as e:
                                logger.error(f"Worker failed job {entry_id}: {e}")

                            # ACK the job (mark as processed)
                            r_ack = await get_redis()
                            await r_ack.xack(JOB_STREAM, CONSUMER_GROUP, entry_id)

            # Periodically check for stale jobs from dead workers
            stale_check_counter += 1
            if stale_check_counter >= (STALE_CHECK_INTERVAL * 1000 // BLOCK_TIMEOUT_MS):
                stale_check_counter = 0
                await _reclaim_stale_jobs()

        except asyncio.CancelledError:
            logger.info("Hunt worker shutting down")
            break
        except Exception as e:
            logger.error(f"Hunt worker error: {e}")
            await asyncio.sleep(2)  # Brief pause before retrying


async def _reclaim_stale_jobs():
    """
    Check for jobs that were claimed but never ACK'd (worker died).
    Re-claim them so this worker can process them.
    """
    r = await get_redis()

    try:
        # XPENDING: get pending (unACK'd) entries in the consumer group
        pending = await r.xpending_range(
            JOB_STREAM, CONSUMER_GROUP,
            min="-", max="+", count=10
        )

        if not pending:
            return

        for entry in pending:
            entry_id = entry.get("message_id", "")
            consumer = entry.get("consumer", "")
            idle_ms = entry.get("time_since_delivered", 0)

            # Only re-claim if idle for longer than threshold AND from a different consumer
            if idle_ms >= STALE_THRESHOLD_MS and consumer != CONSUMER_ID:
                logger.warning(f"Re-claiming stale job {entry_id} from dead worker {consumer} "
                               f"(idle {idle_ms}ms)")

                # XCLAIM: take ownership of the stale job
                claimed = await r.xclaim(
                    JOB_STREAM, CONSUMER_GROUP, CONSUMER_ID,
                    min_idle_time=STALE_THRESHOLD_MS,
                    message_ids=[entry_id]
                )

                for claimed_id, fields in claimed:
                    session_id = fields.get("session_id", "")
                    if session_id:
                        logger.info(f"Re-claimed job {claimed_id} for session {session_id}, resuming hunt")
                        try:
                            await hunt_engine.run_hunt(session_id)
                            logger.info(f"Resumed hunt completed for session {session_id}")
                        except Exception as e:
                            logger.error(f"Resumed hunt failed for session {session_id}: {e}")

                        # ACK after processing
                        await r.xack(JOB_STREAM, CONSUMER_GROUP, claimed_id)

    except Exception as e:
        logger.error(f"Stale job check error: {e}")
