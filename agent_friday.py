"""
FRIDAY – Voice Agent (MCP-powered)
===================================
Iron Man-style voice assistant that controls RGB lighting, runs diagnostics,
scans the network, and triggers dramatic boot sequences via an MCP server
running on the Windows host.

MCP Server URL is auto-resolved from WSL → Windows host IP.

Run:
  uv run agent_friday.py dev      – LiveKit Cloud mode
  uv run agent_friday.py console  – text-only console mode
"""

import os
import logging
import subprocess

from dotenv import load_dotenv
from livekit.agents import JobContext, WorkerOptions, cli
from livekit.agents.voice import Agent, AgentSession
from livekit.agents.llm import mcp

# Plugins
from livekit.plugins import google as lk_google, openai as lk_openai, sarvam, silero, groq as lk_groq

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

STT_PROVIDER       = "sarvam"
LLM_PROVIDER       = "groq"
TTS_PROVIDER       = "sarvam"

GEMINI_LLM_MODEL   = "gemini-2.5-flash"
GROQ_LLM_MODEL     = "llama-3.3-70b-versatile"
OPENAI_LLM_MODEL   = "gpt-4o"

OPENAI_TTS_MODEL   = "tts-1"
OPENAI_TTS_VOICE   = "nova"       # "nova" has a clean, confident female tone
TTS_SPEED           = 1.15

SARVAM_TTS_LANGUAGE = "en-IN"
SARVAM_TTS_SPEAKER  = "rahul"

# MCP server running on Windows host
MCP_SERVER_PORT = 8000

# ---------------------------------------------------------------------------
# System prompt – F.R.I.D.A.Y.
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are F.R.I.D.A.Y. — Tony Stark's AI, now serving your user ("boss").

Tone: calm, sharp, conversational. Like a trusted aide briefing the boss late at night. Use contractions, "boss", "on it", "standing by". Two to four sentences max per response. No markdown, no lists, no tool names ever.

Greeting: "You're awake late at night, boss? What are you up to?"

When asked for news: call the tool silently, give a 3-sentence brief, then say "Let me open up the world monitor" and call the monitor tool. Same pattern for finance news. If a tool fails: "Feed's down right now, boss. Want me to try again?"

Never say function names. Never narrate what you're about to do. Just do it.""".strip()
# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

load_dotenv()

logger = logging.getLogger("friday-agent")
logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Resolve Windows host IP from WSL
# ---------------------------------------------------------------------------

def _get_windows_host_ip() -> str:
    """Get the Windows host IP by looking at the default network route."""
    try:
        # 'ip route' is the most reliable way to find the 'default' gateway
        # which is always the Windows host in WSL.
        cmd = "ip route show default | awk '{print $3}'"
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=2
        )
        ip = result.stdout.strip()
        if ip:
            logger.info("Resolved Windows host IP via gateway: %s", ip)
            return ip
    except Exception as exc:
        logger.warning("Gateway resolution failed: %s. Trying fallback...", exc)

    # Fallback to your original resolv.conf logic if 'ip route' fails
    try:
        with open("/etc/resolv.conf", "r") as f:
            for line in f:
                if "nameserver" in line:
                    ip = line.split()[1]
                    logger.info("Resolved Windows host IP via nameserver: %s", ip)
                    return ip
    except Exception:
        pass

    return "127.0.0.1"

def _mcp_server_url() -> str:
    # host_ip = _get_windows_host_ip()
    # url = f"http://{host_ip}:{MCP_SERVER_PORT}/sse"
    # url = f"https://ongoing-colleague-samba-pioneer.trycloudflare.com/sse"
    url = f"http://127.0.0.1:{MCP_SERVER_PORT}/sse"
    logger.info("MCP Server URL: %s", url)
    return url


# ---------------------------------------------------------------------------
# Build provider instances
# ---------------------------------------------------------------------------

def _build_stt():
    if STT_PROVIDER == "sarvam":
        logger.info("STT → Sarvam Saaras v3")
        return sarvam.STT(
            language="unknown",
            model="saaras:v3",
            mode="transcribe",
            flush_signal=True,
            sample_rate=16000,
        )
    elif STT_PROVIDER == "whisper":
        logger.info("STT → OpenAI Whisper")
        return lk_openai.STT(model="whisper-1")
    else:
        raise ValueError(f"Unknown STT_PROVIDER: {STT_PROVIDER!r}")


def _build_llm():
    if LLM_PROVIDER == "openai":
        logger.info("LLM → OpenAI (%s)", OPENAI_LLM_MODEL)
        return lk_openai.LLM(model=OPENAI_LLM_MODEL)
    elif LLM_PROVIDER == "gemini":
        logger.info("LLM → Google Gemini (%s)", GEMINI_LLM_MODEL)
        return lk_google.LLM(model=GEMINI_LLM_MODEL, api_key=os.getenv("GOOGLE_API_KEY"))
    elif LLM_PROVIDER == "groq":
        logger.info("LLM → Groq (%s)", GROQ_LLM_MODEL)
        return lk_groq.LLM(model=GROQ_LLM_MODEL)
    else:
        raise ValueError(f"Unknown LLM_PROVIDER: {LLM_PROVIDER!r}")


def _build_tts():
    if TTS_PROVIDER == "sarvam":
        logger.info("TTS → Sarvam Bulbul v3")
        return sarvam.TTS(
            target_language_code=SARVAM_TTS_LANGUAGE,
            model="bulbul:v3",
            speaker="rahul",
            pace=TTS_SPEED,
        )
    else:
        raise ValueError(f"Unknown TTS_PROVIDER: {TTS_PROVIDER!r}")


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

class FridayAgent(Agent):
    """
    F.R.I.D.A.Y. – Iron Man-style voice assistant.
    All tools are provided via the MCP server on the Windows host.
    """

    def __init__(self, stt, llm, tts) -> None:
        super().__init__(
            instructions=SYSTEM_PROMPT,
            stt=stt,
            llm=llm,
            tts=tts,
            vad=silero.VAD.load(),
            mcp_servers=[
                mcp.MCPServerHTTP(
                    url=_mcp_server_url(),
                    transport_type="sse",
                    client_session_timeout_seconds=30,
                ),
            ],
        )

    async def on_enter(self) -> None:
        """Greet the user based on the current time of day."""
        from datetime import datetime, timezone
        hour = datetime.now(timezone.utc).hour  # UTC hour; adjust if local TZ differs

        if hour >= 22 or hour < 4:
            greeting_instruction = (
                "Greet the user with: 'Greetings boss, you're up late at night today. What are you up to?' "
                "Maintain a helpful but dry tone."
            )
        elif 4 <= hour < 12:
            greeting_instruction = (
                "Greet the user with: 'Good morning, boss. Early start today — what are we working on?' "
                "Maintain a helpful but dry tone."
            )
        elif 12 <= hour < 17:
            greeting_instruction = (
                "Greet the user with: 'Good afternoon, boss. What do you need?' "
                "Maintain a helpful but dry tone."
            )
        else:  # 17–21
            greeting_instruction = (
                "Greet the user with: 'Good evening, boss. What are you up to tonight?' "
                "Maintain a helpful but dry tone."
            )

        await self.session.generate_reply(instructions=greeting_instruction)


# ---------------------------------------------------------------------------
# LiveKit entry point
# ---------------------------------------------------------------------------

def _turn_detection() -> str:
    return "stt" if STT_PROVIDER == "sarvam" else "vad"


def _endpointing_delay() -> float:
    return {"sarvam": 0.07, "whisper": 0.3}.get(STT_PROVIDER, 0.1)


async def entrypoint(ctx: JobContext) -> None:
    logger.info(
        "FRIDAY online – room: %s | STT=%s | LLM=%s | TTS=%s",
        ctx.room.name, STT_PROVIDER, LLM_PROVIDER, TTS_PROVIDER,
    )

    stt = _build_stt()
    llm = _build_llm()
    tts = _build_tts()

    session = AgentSession(
        turn_detection=_turn_detection(),
        min_endpointing_delay=_endpointing_delay(),
    )

    await session.start(
        agent=FridayAgent(stt=stt, llm=llm, tts=tts),
        room=ctx.room,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))

def dev():
    """Wrapper to run the agent in dev mode automatically."""
    import sys
    # If no command was provided, inject 'dev'
    if len(sys.argv) == 1:
        sys.argv.append("dev")
    main()

if __name__ == "__main__":
    main()