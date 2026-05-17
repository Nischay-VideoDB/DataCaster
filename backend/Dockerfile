# DataCaster — backend service (FastAPI + workers)
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git is needed by pip to install the @hackathon-branch SDK off GitHub.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Python deps first for layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY backend/ ./backend/
COPY scripts/ ./scripts/
# The skill ws_listener (real file) lives under .agents/. The launcher in
# scripts/ws_listener_launcher.py expects to find it at this exact path.
COPY .agents/skills/videodb/scripts/ws_listener.py ./.agents/skills/videodb/scripts/ws_listener.py

ENV VIDEODB_EVENTS_DIR=/tmp \
    HOST=0.0.0.0 \
    PORT=8000

EXPOSE 8000

# Single uvicorn worker (asyncio bus + SQLite expects one process).
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
