# DataCaster — frontend service (React build, served by nginx)

# ── Stage 1: build the production bundle ─────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --prefer-offline

COPY . ./
RUN npm run build

# ── Stage 2: nginx serves the static bundle + proxies /api/* ────────────
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000
