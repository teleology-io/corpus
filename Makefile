# Corpus dev tasks. `make dev` sets everything up (deps, .env, Postgres + Mailpit,
# migrations) and starts web + collab + worker.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PACKAGE_JSONS := package.json $(wildcard apps/*/package.json packages/*/package.json)
INSTALLED := node_modules/.modules.yaml

.PHONY: help dev conductor setup tools install env models services migrate stop down db-reset studio \
	check lint test build format clean \
	deploy-build deploy-up deploy-logs deploy-down

help: ## Show targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

dev: setup ## Install, configure, start services, migrate, run all apps
	$(if $(filter conductor,$(MAKECMDGOALS)),CONDUCTOR=1 )pnpm dev

# `make dev conductor`: dev with the hidden Conductor board on. (Make can't take `--conductor`;
# it reads any --flag as its own option.) `make dev CONDUCTOR=1` does the same.
conductor: ## Use as `make dev conductor` to turn on the hidden Conductor board
	@$(if $(filter dev,$(MAKECMDGOALS)),:,$(MAKE) dev conductor)

setup: tools install env models services migrate ## Everything `dev` needs, without starting the apps

tools: ## Verify node/pnpm/docker (enables pnpm via corepack if missing)
	@command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
	@node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || \
		{ echo "Node.js 22+ is required (found $$(node -v))"; exit 1; }
	@command -v pnpm >/dev/null || { echo "Enabling pnpm via corepack…"; corepack enable; }
	@command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "Docker isn't running — start Docker Desktop and retry."; exit 1; }

install: $(INSTALLED) ## Install dependencies (only when lockfile/package.json changed)

$(INSTALLED): pnpm-lock.yaml $(PACKAGE_JSONS)
	pnpm install
	@touch $@

env: $(INSTALLED) ## Create .env with generated secrets (never overwrites existing values)
	@node scripts/setup-env.mjs

models: ## Download the speech model for note dictation (skips if present)
	@node scripts/fetch-asr-model.mjs

services: ## Start Postgres + Mailpit and wait until healthy
	docker compose up -d --wait

migrate: services ## Apply database migrations
	pnpm db:migrate

stop: ## Stop Postgres + Mailpit (keeps data)
	docker compose stop

down: ## Remove containers (keeps the database volume)
	docker compose down

db-reset: ## DESTRUCTIVE: wipe the database volume and re-migrate
	@read -p "Delete ALL local Corpus data? [y/N] " ok && [ "$$ok" = y ]
	docker compose down -v
	$(MAKE) migrate

studio: services ## Open Drizzle Studio
	pnpm db:studio

check: $(INSTALLED) ## Typecheck all packages
	pnpm check

lint: $(INSTALLED) ## Lint + format check
	pnpm lint
	pnpm format:check

test: $(INSTALLED) ## Unit tests
	pnpm test

build: $(INSTALLED) ## Production build
	pnpm build

format: $(INSTALLED) ## Format everything
	pnpm format

clean: ## Remove node_modules and build output
	rm -rf node_modules apps/*/node_modules packages/*/node_modules \
		apps/web/.svelte-kit apps/web/build apps/*/dist
	rm -rf apps/admin/.svelte-kit apps/admin/build

# ── Docker deployment (deploy/compose.yml, project "corpus-deploy"). Separate from the dev
# services above: these never stop or reuse the dev Postgres. Needs deploy/.env.
DEPLOY := docker compose -f deploy/compose.yml --env-file deploy/.env

deploy/.env:
	@echo "Create deploy/.env first: cp deploy/.env.example deploy/.env (then set the secrets)"; exit 1

deploy-build: deploy/.env ## Build the Corpus image
	$(DEPLOY) build

deploy-up: deploy/.env ## Build + start the full Docker stack (migrates first)
	$(DEPLOY) up -d --build

deploy-logs: deploy/.env ## Follow logs of the Docker stack
	$(DEPLOY) logs -f --tail=100

deploy-down: deploy/.env ## Stop the Docker stack (keeps its volumes)
	$(DEPLOY) down
