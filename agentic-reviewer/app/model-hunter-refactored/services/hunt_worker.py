"""
Hunt Worker — Background job processor for hunt execution.

Decouples hunt execution from HTTP/SSE connections.
Hunts are submitted as jobs to a Redis Stream (mh:hunt_jobs).
Worker loops in each container claim and process jobs.

If a container dies mid-hunt:
- The job stays unACK'd in the consumer group
- The heartbeat key (mh:hunt_active:{session_id}) expires (30s TTL)
- The other container's worker sees: pending job + no heartbeat = dead worker
- Re-claims the job (XCLAIM) and resumes the hunt
- Already-completed results in Redis are skipped (resumable execution)

Stream: mh:hunt_jobs
Consumer group: hunt_workers
Consumer ID: {hostname}:{pid} (unique per container process)
"""
import asyncio
import os
import logging

from services.redis_session import get_redis, get_redis_blocking
from services.hunt_engine import hunt_engine

logger = logging.getLogger(__name__)

# Configuration
JOB_STREAM = "mh:hunt_jobs"
CONSUMER_GROUP = "hunt_workers"
CONSUMER_ID = f"{os.getenv('HOSTNAME', 'local')}:{os.getpid()}"
BLOCK_TIMEOUT_MS = 5000       # Poll every 5s for new jobs
STALE_CHECK_INTERVAL = 10     # Check for stale jobs every 10s


def _get_heartbeat_ttl():
    from agentic_reviewer.config_loader import get_config_value
    return get_config_value("session.heartbeat_ttl_seconds") or 30


HEARTBEAT_TTL = _get_heartbeat_ttl()
HEARTBEAT_INTERVAL = 10       # Refresh heartbeat every 10s
MAX_STREAM_LEN = 500          # Keep last 500 jobs in stream

HEARTBEAT_PREFIX = "mh:hunt_active"


def _heartbeat_key(session_id: str) -> str:
    return f"{HEARTBEAT_PREFIX}:{session_id}"


async def _ensure_consumer_group():
    """Create the consumer group if it doesn't exist."""
    r = await get_redis()
    try:
        await r.xgroup_create(JOB_STREAM, CONSUMER_GROUP, id="0", mkstream=True)
        logger.info(f"Created consumer group '{CONSUMER_GROUP}' on '{JOB_STREAM}'")
    except Exception as e:
        if "BUSYGROUP" in str(e):
            pass
        else:
            logger.error(f"Error creating consumer group: {e}")


async def submit_hunt_job(session_id: str) -> str:
    """
    Submit a hunt job to the Redis Stream.
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


async def _run_with_heartbeat(session_id: str):
    """
    Run hunt_engine.run_hunt while maintaining a heartbeat key in Redis.
    The heartbeat key tells other workers "I'm alive, don't re-claim my job."
    If this worker dies, the key expires in 30s, signaling a dead worker.
    """
    r = await get_redis()
    hb_key = _heartbeat_key(session_id)

    # Set initial heartbeat
    await r.set(hb_key, CONSUMER_ID, ex=HEARTBEAT_TTL)

    # Start heartbeat refresh task
    async def refresh_heartbeat():
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                await r.set(hb_key, CONSUMER_ID, ex=HEARTBEAT_TTL)
        except asyncio.CancelledError:
            pass

    heartbeat_task = asyncio.create_task(refresh_heartbeat())

    try:
        await hunt_engine.run_hunt(session_id)
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        # Remove heartbeat on completion
        await r.delete(hb_key)


async def run_worker_loop():
    """
    Main worker loop — runs as a background task in each container.
    Claims jobs from the Redis Stream and executes hunts.
    Periodically checks for stale jobs from dead workers (heartbeat expired).
    """
    await _ensure_consumer_group()

    logger.info(f"Hunt worker started: consumer={CONSUMER_ID}, group={CONSUMER_GROUP}")

    stale_check_counter = 0

    while True:
        try:
            r = await get_redis_blocking()
            result = await r.xreadgroup(
                CONSUMER_GROUP,
                CONSUMER_ID,
                {JOB_STREAM: ">"},
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
                                await _run_with_heartbeat(session_id)
                                logger.info(f"Worker completed job {entry_id} for session {session_id}")
                            except Exception as e:
                                logger.error(f"Worker failed job {entry_id}: {e}")

                            # ACK the job
                            r_ack = await get_redis()
                            await r_ack.xack(JOB_STREAM, CONSUMER_GROUP, entry_id)

            # Periodically check for stale jobs
            stale_check_counter += 1
            if stale_check_counter >= (STALE_CHECK_INTERVAL * 1000 // BLOCK_TIMEOUT_MS):
                stale_check_counter = 0
                await _reclaim_stale_jobs()

        except asyncio.CancelledError:
            logger.info("Hunt worker shutting down")
            break
        except Exception as e:
            logger.error(f"Hunt worker error: {e}")
            await asyncio.sleep(2)


async def _reclaim_stale_jobs():
    """
    Check for pending (unACK'd) jobs where the worker's heartbeat has expired.
    Only re-claim if: job is pending AND heartbeat key is missing (worker dead).
    This prevents double re-claims from workers that are still processing.
    """
    r = await get_redis()

    try:
        pending = await r.xpending_range(
            JOB_STREAM, CONSUMER_GROUP,
            min="-", max="+", count=10
        )

        if not pending:
            return

        for entry in pending:
            entry_id = entry.get("message_id", "")
            consumer = entry.get("consumer", "")

            # Skip our own pending jobs
            if consumer == CONSUMER_ID:
                continue

            # Read the job to get the session_id
            msgs = await r.xrange(JOB_STREAM, min=entry_id, max=entry_id, count=1)
            if not msgs:
                continue

            _, fields = msgs[0]
            session_id = fields.get("session_id", "")
            if not session_id:
                continue

            # Check heartbeat — only re-claim if heartbeat key is MISSING (worker dead)
            hb_key = _heartbeat_key(session_id)
            heartbeat_exists = await r.exists(hb_key)

            if heartbeat_exists:
                # Worker is alive, just slow. Don't re-claim.
                continue

            # No heartbeat → worker is dead. Safe to re-claim.
            logger.warning(f"Re-claiming job {entry_id} for session {session_id} "
                           f"(worker {consumer} heartbeat expired)")

            claimed = await r.xclaim(
                JOB_STREAM, CONSUMER_GROUP, CONSUMER_ID,
                min_idle_time=0,
                message_ids=[entry_id]
            )

            for claimed_id, claimed_fields in claimed:
                sid = claimed_fields.get("session_id", "")
                if sid:
                    logger.info(f"Re-claimed job {claimed_id} for session {sid}, resuming hunt")
                    try:
                        await _run_with_heartbeat(sid)
                        logger.info(f"Resumed hunt completed for session {sid}")
                    except Exception as e:
                        logger.error(f"Resumed hunt failed for session {sid}: {e}")

                    await r.xack(JOB_STREAM, CONSUMER_GROUP, claimed_id)

    except Exception as e:
        logger.error(f"Stale job check error: {e}")
