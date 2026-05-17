# ──────────────────────────────────────────────────────────────────────────
# DataCaster — make targets
#
# Quick reference:
#   make             show this help
#   make datacaster  one-shot: build images + start both services
#   make up          start both services (no rebuild)
#   make down        stop both services
#   make logs        tail logs (both services)
# ──────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
COMPOSE := docker compose
PROJECT := datacaster

# ANSI colours for help output
CYAN  := \033[36m
BOLD  := \033[1m
DIM   := \033[2m
RESET := \033[0m

.DEFAULT_GOAL := help

.PHONY: help datacaster build up down restart rebuild logs logs-backend logs-frontend \
        ps status health shell-backend shell-frontend clean nuke open dev-backend \
        dev-frontend smoke

help: ## show this help
	@printf "$(BOLD)DataCaster$(RESET) — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"} \
	      /^[a-zA-Z_-]+:.*##/ { printf "  $(CYAN)%-18s$(RESET) %s\n", $$1, $$2 }' \
	      $(MAKEFILE_LIST)
	@printf "\n$(DIM)Frontend → http://localhost:3000   Backend → http://localhost:8000$(RESET)\n"

# ── Lifecycle ───────────────────────────────────────────────────────────

datacaster: build up open ## build + start + open browser (one-shot)

build: ## docker compose build (both services)
	$(COMPOSE) build

up: ## start both services in the background
	$(COMPOSE) up -d
	@printf "\n$(BOLD)ready$(RESET)  →  $(CYAN)http://localhost:3000$(RESET)  (frontend)\n"
	@printf "        →  $(CYAN)http://localhost:8000$(RESET)  (backend api)\n\n"

down: ## stop both services
	$(COMPOSE) down

restart: down up ## stop + start

rebuild: ## rebuild from scratch (no cache) and start
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d --force-recreate
	@printf "\n$(BOLD)rebuilt + restarted$(RESET)  →  http://localhost:3000\n\n"

# ── Observability ───────────────────────────────────────────────────────

logs: ## tail logs from both services
	$(COMPOSE) logs -f

logs-backend: ## tail backend logs only
	$(COMPOSE) logs -f backend

logs-frontend: ## tail frontend logs only
	$(COMPOSE) logs -f frontend

ps status: ## show service status
	@$(COMPOSE) ps

health: ## hit /api/health and show pipeline state
	@curl -sS http://localhost:8000/api/health | python3 -m json.tool 2>/dev/null \
	  || echo "backend not reachable on :8000"

# ── Debugging ───────────────────────────────────────────────────────────

shell-backend: ## open a shell inside the backend container
	$(COMPOSE) exec backend bash

shell-frontend: ## open a shell inside the frontend container
	$(COMPOSE) exec frontend sh

# ── Cleanup ─────────────────────────────────────────────────────────────

clean: down ## stop services and remove built images
	-docker image rm datacaster-backend:latest datacaster-frontend:latest 2>/dev/null
	@printf "\nremoved containers + images for project $(PROJECT)\n"

nuke: clean ## clean + drop volumes + prune dangling images
	$(COMPOSE) down -v
	-docker image prune -f
	@printf "\nfull cleanup done\n"

# ── Local dev (no Docker) ───────────────────────────────────────────────

dev-backend: ## run uvicorn locally with reload (uses .venv)
	. .venv/bin/activate && uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

dev-frontend: ## run Vite locally (HMR)
	cd frontend && npm run dev

# ── Smoke test ──────────────────────────────────────────────────────────

smoke: ## verify both services answer
	@printf "frontend (:3000)  → "
	@curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/ || echo "down"
	@printf "backend  (:8000)  → "
	@curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/health || echo "down"
	@printf "proxy    (:3000/api/health) → "
	@curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health || echo "down"

open: ## open the frontend in the default browser
	@command -v open >/dev/null 2>&1 && open http://localhost:3000 || \
	  printf "open http://localhost:3000 in your browser\n"
