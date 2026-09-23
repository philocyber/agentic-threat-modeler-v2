.PHONY: help setup run stop services-up services-down services\:up services\:down migrate rag-index check-ollama build

help:
	@echo "Argus local PoC: make setup | run | stop | rag-index | check-ollama"
	@echo "setup installs dependencies and starts local services; prepare approved knowledge separately."

setup:
	pnpm install --frozen-lockfile
	pnpm services:up

run:
	pnpm dev

stop services-down:
	pnpm services:down

services-up:
	pnpm services:up

services\:up: services-up
services\:down: services-down

# Optional PostgreSQL migration; local SQLite migrates when a project is created.
migrate:
	pnpm drizzle:migrate

rag-index:
	pnpm rag:index

check-ollama:
	node scripts/dev.mjs models

build:
	docker build -t argus .
